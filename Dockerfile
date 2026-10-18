FROM node:24-alpine

ENV NODE_ENV=production \
    EZD_DATA_DIR=/data \
    EZD_PORT=80

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force

COPY src ./src
COPY public ./public
COPY examples ./examples

VOLUME /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${EZD_PORT}/api/health" > /dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
