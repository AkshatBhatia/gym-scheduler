FROM node:20-slim AS builder

WORKDIR /app

# Install dashboard dependencies and build
COPY dashboard/package.json dashboard/package-lock.json dashboard/
RUN cd dashboard && npm ci --no-audit --no-fund

COPY dashboard/ dashboard/
RUN cd dashboard && npm run build

# Install server dependencies and build
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --no-audit --no-fund

COPY server/ server/
RUN cd server && npm run build

# Production image
FROM node:20-slim

WORKDIR /app

COPY --from=builder /app/dashboard/dist dashboard/dist
COPY --from=builder /app/dashboard/public dashboard/dist
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --no-audit --no-fund --omit=dev

COPY --from=builder /app/server/dist server/dist

RUN mkdir -p server/data

EXPOSE 3001

WORKDIR /app/server
CMD ["node", "dist/index.js"]
