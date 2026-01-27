FROM mcr.microsoft.com/playwright:v1.58.0-jammy

WORKDIR /app

# Install build dependencies for native modules
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

VOLUME /app/data

CMD ["npm", "start"]
