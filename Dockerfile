FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

EXPOSE 80

ENV PORT=80

CMD ["node", "server.js"]
