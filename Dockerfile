FROM node:20

WORKDIR /app

# Copy everything (node_modules excluded via .dockerignore)
COPY . .

# Install and build dashboard
RUN cd dashboard && npm ci && ./node_modules/.bin/vite build

# Install and build server
RUN cd server && npm ci && ./node_modules/.bin/tsc

# Clean up dev dependencies
RUN cd server && npm prune --production

EXPOSE 3001
WORKDIR /app/server
CMD ["node", "dist/index.js"]
