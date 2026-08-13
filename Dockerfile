FROM node:24-bookworm-slim

# git and tar are used by the deploy and backup pipelines; python3 and its venv
# module let Python bots install their own dependencies inside the container.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      tar \
      gzip \
      python3 \
      python3-venv \
      python3-pip \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the processes bots leave behind, so PID 1 does not accumulate zombies.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
