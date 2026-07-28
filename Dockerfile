# Playwright's official image already has Chromium + all OS-level dependencies
# preinstalled and version-matched to the playwright npm package - this avoids
# the most common source of "works locally, breaks on the server" Playwright bugs.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

# ffmpeg is needed to convert Playwright's native .webm recording to .mp4,
# per the platform's contract ("Playwright Worker -> MP4 -> Return Video").
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
