# =============================================================================
# Dockerfile — HerumHai PenguPlay Edition (Ultra-Lightweight)
# -----------------------------------------------------------------------------
# node:20-alpine base = ~50MB image (vs ~350MB for slim + chromium)
# NO Puppeteer, NO Playwright, NO FlareSolverr — pure HTTP only
# Perfect for SnapDeploy free tier (512MB RAM)
# =============================================================================

FROM node:20-alpine

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=7000

# Copy package files first (for Docker layer caching)
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --only=production 2>/dev/null || npm install --only=production

# Copy application code + static public folder
COPY server.js ./
COPY src/ ./src/
COPY public/ ./public/

# Expose the unified port
EXPOSE 7000

# Health check (lightweight — just check if server responds)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT:-7000}/health || exit 1

# Run as non-root user (Alpine has 'node' user built-in)
USER node

# Start the unified server
CMD ["node", "server.js"]
