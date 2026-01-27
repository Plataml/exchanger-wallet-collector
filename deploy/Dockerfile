FROM mcr.microsoft.com/playwright:v1.58.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build

VOLUME /app/data

CMD ["npm", "start"]
