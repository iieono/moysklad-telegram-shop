FROM node:20-alpine AS builder

RUN apk add --no-cache openssl

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci && \
    npm cache clean --force

# Copy source and build
COPY . .
RUN npx prisma generate && \
    npm run build && \
    npm prune --production

# Production image
FROM node:20-alpine

# Install wget and openssl
RUN apk add --no-cache wget openssl

WORKDIR /app

# Copy built files and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/assets ./assets

# Create logs directory and fix permissions
RUN mkdir -p logs assets && chown -R node:node /app

# Use non-root user
USER node

EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
