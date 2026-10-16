FROM mcr.microsoft.com/playwright:v1.55.0-noble

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY 04-slot-sniper/ ./04-slot-sniper/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN for brand in shuangbao qiezi yingma; do \
      cd /app/04-slot-sniper/$brand && npm install --omit=dev && npm install --no-save playwright@1.55.0; \
    done
ENV DISPLAY=:99
ENV NODE_ENV=production
EXPOSE 8080 6080
CMD ["bash", "/app/04-slot-sniper/cloudflare/start.sh"]
