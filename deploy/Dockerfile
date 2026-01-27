FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

VOLUME /app/data

CMD ["npm", "start"]
