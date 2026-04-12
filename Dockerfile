FROM node:22-slim

WORKDIR /app

# Install dashboard dependencies and build
COPY dashboard/package.json dashboard/package-lock.json* dashboard/
RUN cd dashboard && npm install

COPY dashboard/ dashboard/
RUN cd dashboard && npm run build

# Install server dependencies and build
COPY server/package.json server/package-lock.json* server/
RUN cd server && npm install

COPY server/ server/
RUN cd server && npm run build

# Create data directory for SQLite
RUN mkdir -p server/data

EXPOSE 3001

WORKDIR /app/server
CMD ["node", "dist/index.js"]
