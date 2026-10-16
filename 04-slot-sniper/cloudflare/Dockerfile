FROM node:22-bookworm-slim

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY 04-slot-sniper/shuangbao/package*.json ./04-slot-sniper/shuangbao/
COPY 04-slot-sniper/qiezi/package*.json ./04-slot-sniper/qiezi/
COPY 04-slot-sniper/yingma/package*.json ./04-slot-sniper/yingma/
RUN for brand in shuangbao qiezi yingma; do \
      cd /app/04-slot-sniper/$brand && npm install --omit=dev && npm install --no-save playwright@1.55.0; \
    done
RUN cd /app/04-slot-sniper/yingma && npx playwright install --with-deps chromium
COPY 04-slot-sniper/ ./04-slot-sniper/
ENV DISPLAY=:99
ENV NODE_ENV=production
EXPOSE 8080 6080
CMD ["bash", "/app/04-slot-sniper/cloudflare/start.sh"]
