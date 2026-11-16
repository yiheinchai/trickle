# The trickle-lite server (`trickle-lite serve`). Build dist first: npm run build.
# Needs DATABASE_URL, TRICKLE_INGEST_TOKEN and TRICKLE_READ_TOKEN at runtime.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY dist ./dist
USER node
EXPOSE 4889
CMD ["node", "dist/cli.js", "serve"]
