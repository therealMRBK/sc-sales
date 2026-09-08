FROM node:22-bookworm-slim

# better-sqlite3 baut ein natives Modul -- braucht Build-Tools/Python zur
# Installationszeit, danach nicht mehr im Laufzeit-Image nötig.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000
ENV DATA_DIR=/data
ENV SCAN_INTERVAL_MINUTES=180
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
