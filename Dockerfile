FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Self-contained yt-dlp binary (no Python needed)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    YTDLP_BIN=/usr/local/bin/yt-dlp \
    JS_RUNTIME=node \
    CACHE_DIR=/tmp/cache \
    MAX_CACHE_MB=400 \
    MAX_CONCURRENT_DOWNLOADS=1

# Update yt-dlp on every start (Render free spins down/up often), then run the API
CMD ["sh", "-c", "yt-dlp -U >/dev/null 2>&1 || true; exec node server.js"]
