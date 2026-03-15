FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --production 2>/dev/null || npm install --production

# Copy built files
COPY dist/ dist/

# Create data directory
RUN mkdir -p /data

ENV PORT=4888
ENV TRICKLE_DB_PATH=/data/trickle.db

EXPOSE 4888

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:4888/api/health || exit 1

CMD ["node", "dist/index.js"]
