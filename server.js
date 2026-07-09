const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ====== 系统模式配置 ======
// 存在 config.json 中，后台可通过API切换
const CONFIG_FILE = path.join(__dirname, 'config.json');

function getDefaultConfig() {
  return { mode: 'formal' }; // 'formal' | 'test'
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {}
  return getDefaultConfig();
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// 初始化配置
if (!fs.existsSync(CONFIG_FILE)) {
  saveConfig(getDefaultConfig());
}
let systemConfig = loadConfig();

// ====== 数据库初始化 ======
const db = new Database(path.join(__dirname, 'data', 'survey.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    env_mode TEXT DEFAULT 'formal',

    -- 基本信息
    name TEXT,
    enroll_year TEXT,
    identity TEXT,
    industry TEXT,
    work_years TEXT,

    -- 第二部分：AI使用现状
    daily_ai_time TEXT,
    ai_scenarios TEXT,

    -- 第三部分：痛点挖掘
    time_wasters TEXT,
    most_wanted_one TEXT,
    blockers TEXT,

    -- AI成熟度
    ai_maturity TEXT,

    -- 第四部分：学习需求
    desired_outcomes TEXT,
    learning_directions TEXT,

    -- 第五部分：商业验证
    learning_format TEXT,
    learning_duration TEXT,
    payment_targets TEXT,
    lookback TEXT,

    -- 元数据
    user_agent TEXT,
    ip TEXT
  )
`);

// ====== 通用工具函数 ======

function buildWhere(envMode) {
  if (envMode && envMode !== 'all') {
    return `WHERE env_mode = '${envMode}'`;
  }
  return '';
}

function parseRow(row) {
  return {
    ...row,
    ai_scenarios: JSON.parse(row.ai_scenarios || '[]'),
    time_wasters: JSON.parse(row.time_wasters || '[]'),
    blockers: JSON.parse(row.blockers || '[]'),
    desired_outcomes: JSON.parse(row.desired_outcomes || '[]'),
    learning_directions: JSON.parse(row.learning_directions || '[]'),
    payment_targets: JSON.parse(row.payment_targets || '[]'),
  };
}

// ====== API 路由 ======

// 提交问卷 — 自动根据系统当前模式标记
app.post('/api/submit', (req, res) => {
  try {
    const data = req.body;
    // 提交时自动使用系统当前模式，填写端无需关心
    const envMode = systemConfig.mode;
    // 优先使用前端传来的用户本地时间，否则回退到服务器时间
    const createdAt = data.submitted_at || null;

    const stmt = db.prepare(`
      INSERT INTO responses (
        created_at,
        env_mode,
        name, enroll_year,
        identity, industry, work_years,
        daily_ai_time, ai_scenarios,
        time_wasters, most_wanted_one, blockers,
        ai_maturity,
        desired_outcomes, learning_directions,
        learning_format, learning_duration, payment_targets,
        lookback,
        user_agent, ip
      ) VALUES (
        ?,
        ?,
        ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?,
        ?, ?,
        ?, ?, ?,
        ?,
        ?, ?
      )
    `);

    const result = stmt.run(
      createdAt,
      envMode,
      data.name || null,
      data.enroll_year || null,
      data.identity || null,
      data.industry || null,
      data.work_years || null,
      data.daily_ai_time || null,
      JSON.stringify(data.ai_scenarios || []),
      JSON.stringify(data.time_wasters || []),
      data.most_wanted_one || null,
      JSON.stringify(data.blockers || []),
      data.ai_maturity || null,
      JSON.stringify(data.desired_outcomes || []),
      JSON.stringify(data.learning_directions || []),
      JSON.stringify(data.learning_format || []),
      data.learning_duration || null,
      JSON.stringify(data.payment_targets || []),
      data.lookback || null,
      req.headers['user-agent'] || null,
      req.ip || null
    );

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('提交失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取问卷数据（按时间倒序，支持env过滤）
app.get('/api/responses', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const envMode = req.query.env || 'all';

    const where = buildWhere(envMode);

    const total = db.prepare(`SELECT COUNT(*) as count FROM responses ${where}`).get().count;
    const rows = db.prepare(`SELECT * FROM responses ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset);

    const parsed = rows.map(parseRow);
    res.json({ success: true, data: parsed, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取统计数据（支持env过滤）
app.get('/api/stats', (req, res) => {
  try {
    const envMode = req.query.env || 'all';
    const where = buildWhere(envMode);
    const whereWithField = (field) => {
      return where ? `${where} AND ${field} IS NOT NULL` : `WHERE ${field} IS NOT NULL`;
    };

    const total = db.prepare(`SELECT COUNT(*) as count FROM responses ${where}`).get().count;
    const testCount = db.prepare("SELECT COUNT(*) as count FROM responses WHERE env_mode = 'test'").get().count;
    const formalCount = db.prepare("SELECT COUNT(*) as count FROM responses WHERE env_mode = 'formal'").get().count;

    // 单选字段统计
    const queryDist = (field) => db.prepare(`
      SELECT ${field} as value, COUNT(*) as count FROM responses ${whereWithField(field)} GROUP BY ${field} ORDER BY count DESC
    `).all();

    const identityDist = queryDist('identity');
    const enrollYearDist = queryDist('enroll_year');
    const workYearsDist = queryDist('work_years');
    const dailyAiTimeDist = queryDist('daily_ai_time');
    const aiMaturityDist = queryDist('ai_maturity');
    const learningFormatDist = queryDist('learning_format');
    const learningDurationDist = queryDist('learning_duration');

    // 多选字段统计
    const queryJsonDist = (field) => {
      const fieldWhere = where ? `${where} AND ${field} IS NOT NULL AND ${field} != '[]'` : `WHERE ${field} IS NOT NULL AND ${field} != '[]'`;
      const rows = db.prepare(`SELECT ${field} FROM responses ${fieldWhere}`).all();
      const counts = {};
      for (const row of rows) {
        let items = [];
        try { items = JSON.parse(row[field] || '[]'); } catch(e) { continue; }
        for (const item of items) {
          counts[item] = (counts[item] || 0) + 1;
        }
      }
      return Object.entries(counts).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
    };

    const aiScenariosDist = queryJsonDist('ai_scenarios');
    const timeWastersDist = queryJsonDist('time_wasters');
    const blockersDist = queryJsonDist('blockers');
    const desiredOutcomesDist = queryJsonDist('desired_outcomes');
    const learningDirectionsDist = queryJsonDist('learning_directions');
    const learningFormatDist = queryJsonDist('learning_format');
    const paymentTargetsDist = queryJsonDist('payment_targets');

    res.json({
      success: true,
      stats: {
        total, testCount, formalCount,
        identityDist, enrollYearDist, workYearsDist,
        dailyAiTimeDist, aiScenariosDist,
        timeWastersDist, blockersDist,
        aiMaturityDist,
        desiredOutcomesDist, learningDirectionsDist,
        learningFormatDist, learningDurationDist,
        paymentTargetsDist
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====== 后台管理 API ======

// 获取/切换系统模式
app.get('/api/mode', (req, res) => {
  res.json({ success: true, mode: systemConfig.mode });
});

app.put('/api/mode', (req, res) => {
  try {
    const newMode = req.body.mode;
    if (newMode !== 'test' && newMode !== 'formal') {
      return res.status(400).json({ success: false, error: '模式只能是 test 或 formal' });
    }
    systemConfig.mode = newMode;
    saveConfig(systemConfig);
    res.json({ success: true, mode: newMode });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 清除指定模式的数据（DELETE 方法，供 fetch/XHR 调用）
app.delete('/api/data', (req, res) => {
  try {
    const targetMode = req.query.mode; // 'test' | 'formal' | 'all'
    let sql = 'DELETE FROM responses';
    let label = '全部';
    if (targetMode === 'test') {
      sql += " WHERE env_mode = 'test'";
      label = '测试';
    } else if (targetMode === 'formal') {
      sql += " WHERE env_mode = 'formal'";
      label = '正式';
    }
    const result = db.prepare(sql).run();
    res.json({ success: true, deleted: result.changes, label });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 清除指定模式的数据（POST 方法，供表单提交调用，兼容性更好）
app.post('/api/clear', (req, res) => {
  try {
    const targetMode = req.body.mode; // 'test' | 'formal' | 'all'
    let sql = 'DELETE FROM responses';
    let label = '全部';
    if (targetMode === 'test') {
      sql += " WHERE env_mode = 'test'";
      label = '测试';
    } else if (targetMode === 'formal') {
      sql += " WHERE env_mode = 'formal'";
      label = '正式';
    }
    const result = db.prepare(sql).run();
    res.send('<script>parent.postMessage("ok","*");</script>');
  } catch (err) {
    res.status(500).send('error');
  }
});

// 清除数据（GET方式，执行删除后重定向回后台）
app.get('/api/do-clear', (req, res) => {
  try {
    const targetMode = req.query.mode;
    let sql = 'DELETE FROM responses';
    let label = '全部';
    if (targetMode === 'test') {
      sql += " WHERE env_mode = 'test'";
      label = '测试';
    } else if (targetMode === 'formal') {
      sql += " WHERE env_mode = 'formal'";
      label = '正式';
    }
    const result = db.prepare(sql).run();
    res.redirect('/admin?cleared=' + encodeURIComponent(label) + '&count=' + result.changes);
  } catch (err) {
    res.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
});

// 清除数据（表单提交 + 重定向回后台页面）
app.post('/api/clear-redirect', (req, res) => {
  try {
    const targetMode = req.body.mode;
    let sql = 'DELETE FROM responses';
    let label = '全部';
    if (targetMode === 'test') {
      sql += " WHERE env_mode = 'test'";
      label = '测试';
    } else if (targetMode === 'formal') {
      sql += " WHERE env_mode = 'formal'";
      label = '正式';
    }
    const result = db.prepare(sql).run();
    // 重定向回后台，带上清除结果提示
    res.redirect('/admin?cleared=' + encodeURIComponent(label) + '&count=' + result.changes);
  } catch (err) {
    res.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
});

// 导出CSV（支持env过滤）
app.get('/api/export', (req, res) => {
  try {
    const envMode = req.query.env || 'all';
    const where = buildWhere(envMode);

    const rows = db.prepare(`SELECT * FROM responses ${where} ORDER BY id DESC`).all();

    const fields = [
      'id', 'created_at', 'env_mode', 'name', 'enroll_year', 'identity', 'industry', 'work_years',
      'daily_ai_time', 'ai_scenarios', 'time_wasters', 'most_wanted_one', 'blockers',
      'ai_maturity', 'desired_outcomes', 'learning_directions',
      'learning_format', 'learning_duration', 'payment_targets', 'lookback'
    ];

    let csv = '\uFEFF' + fields.join(',') + '\n';
    for (const row of rows) {
      const line = fields.map(f => {
        let val = row[f] || '';
        val = String(val).replace(/"/g, '""');
        return `"${val}"`;
      }).join(',');
      csv += line + '\n';
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=survey_data.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====== 表单配置 API ======
const FORM_CONFIG_FILE = path.join(__dirname, 'form-config.json');

// 获取表单配置
app.get('/api/form-config', (req, res) => {
  try {
    if (fs.existsSync(FORM_CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(FORM_CONFIG_FILE, 'utf-8'));
      res.json({ success: true, config });
    } else {
      res.json({ success: true, config: null });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 更新表单配置（需要密码）
app.put('/api/form-config', (req, res) => {
  try {
    const { password, config } = req.body;
    if (password !== 'admin123') {
      return res.status(403).json({ success: false, error: '密码错误' });
    }
    fs.writeFileSync(FORM_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====== 页面路由 ======
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ====== 启动 ======
app.listen(PORT, () => {
  console.log(`问卷系统已启动: http://localhost:${PORT}`);
  console.log(`当前模式: ${systemConfig.mode === 'test' ? '测试' : '正式'}`);
  console.log(`填写问卷: http://localhost:${PORT}`);
  console.log(`后台管理: http://localhost:${PORT}/admin`);
});