FROM oven/bun:1.1-slim AS base
WORKDIR /app

# Install dependencies (leverage layer cache)
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

# Copy application source code
COPY index.ts tsconfig.json ./
COPY db/ ./db/
COPY models/ ./models/
COPY views/ ./views/

# Render sets process.env.PORT automatically, default to 3000
EXPOSE 3000

ENV NODE_ENV=production

CMD ["bun", "run", "index.ts"]
