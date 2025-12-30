# Use Node.js LTS version
FROM node:20-slim

# Create app directory
WORKDIR /usr/src/app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

# Set environment variables
ENV NODE_ENV=production

# Create a non-root user
RUN useradd -m -r -u 1001 botuser \
    && chown -R botuser:botuser /usr/src/app

# Switch to non-root user
USER botuser

# Start the bot
CMD [ "npm", "start" ] 