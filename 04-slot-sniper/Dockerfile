FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copy root and submodules
COPY package*.json ./
RUN npm install

COPY . .

ENV HEADLESS=true
ENV NODE_ENV=production

# Default command runs the cloud slot sniper
CMD ["node", "04-slot-sniper/run-cloud-sniper.mjs", "--brand=all"]
