FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# EasyPanel rutea al puerto 80
EXPOSE 80

ENV PORT=80
ENV NODE_ENV=production

CMD ["node", "server.js"]
