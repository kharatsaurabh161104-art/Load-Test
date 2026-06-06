FROM oven/bun:latest

WORKDIR /app

# Copy package definition and install dependencies

COPY package.json ./
RUN bun install
# Copy application source code

COPY index.ts tsconfig.json ./
COPY db/ ./db/
COPY models/ ./models/
COPY views/ ./views/

ENV NODE_ENV=production

# Render provides PORT automatically

EXPOSE 3000

CMD ["bun", "run", "index.ts"]
