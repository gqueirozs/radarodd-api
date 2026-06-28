FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --only=production --legacy-peer-deps

COPY . .

EXPOSE 3001

CMD ["node", "src/server.js"]
