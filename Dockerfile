FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --only=production
RUN npx playwright install chromium

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
