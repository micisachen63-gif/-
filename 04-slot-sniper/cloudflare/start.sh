#!/usr/bin/env bash
set -euo pipefail
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
x11vnc -display :99 -forever -shared -nopw -listen 127.0.0.1 -rfbport 5900 -quiet &
websockify --web=/usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 &
exec node /app/04-slot-sniper/cloudflare/container-server.mjs
