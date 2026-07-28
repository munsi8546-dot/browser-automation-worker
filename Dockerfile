FROM node:20-bookworm-slim

# ffmpeg (webm -> mp4) + Chromium-এর system libraries
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

# Playwright-এর Chromium + OS deps install
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 10000

CMD ["node", "server.js"]
