FROM mcr.microsoft.com/playwright:v1.41.2-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npx playwright install chromium

CMD ["npm", "start"]