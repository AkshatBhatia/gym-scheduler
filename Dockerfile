FROM node:20-slim AS builder

ENV NODE_ENV=development
WORKDIR /app

# Install dashboard dependencies and build
COPY dashboard/package.json dashboard/package-lock.json dashboard/
WORKDIR /app/dashboard
RUN npm ci --no-audit --no-fund
COPY dashboard/ .
RUN ./node_modules/.bin/vite build

# Install server dependencies and build
WORKDIR /app
COPY server/package.json server/package-lock.json server/
WORKDIR /app/server
RUN npm ci --no-audit --no-fund
COPY server/ .
RUN ./node_modules/.bin/tsc

# Production image
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/dashboard/dist dashboard/dist
COPY dashboard/public/ dashboard/dist/

WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=dev
COPY --from=builder /app/server/dist ./dist

RUN mkdir -p data

EXPOSE 3001
CMD ["node", "dist/index.js"]
