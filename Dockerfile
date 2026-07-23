FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7000

COPY package.json package-lock.json* ./
RUN npm ci --only=production 2>/dev/null || npm install --only=production

COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT:-7000}/health || exit 1

USER node

CMD ["node", "server.js"]
