FROM node:20.18-bookworm

WORKDIR /app
COPY . .

# Install and build dashboard
RUN cd dashboard && npm install --no-audit --no-fund && ./node_modules/.bin/vite build

# Install and build server
RUN cd server && npm install --no-audit --no-fund && ./node_modules/.bin/tsc

# Clean up dev dependencies
RUN cd server && npm prune --production

EXPOSE 3001
WORKDIR /app/server
CMD ["node", "dist/index.js"]
