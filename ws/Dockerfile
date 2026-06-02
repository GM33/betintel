FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json .
RUN npm install --omit=dev

# Copy source
COPY server.js .
COPY ingest.js .

# Expose WebSocket port
EXPOSE 8080

# Default: run WS server
# Override CMD in docker-compose or Railway to run ingest worker
CMD ["node", "server.js"]
