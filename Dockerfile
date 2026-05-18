FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
