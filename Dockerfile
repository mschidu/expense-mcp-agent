# Dockerfile

FROM node:22-alpine

# Create app directory
WORKDIR /app

# Install only prod dependencies first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# Copy the actual source
COPY . ./ 

# Environment hint
ENV NODE_ENV=production

# Default command: run the Telegram + LLM client,
# which will internally spawn server.js as MCP server
CMD ["npm", "start"]
