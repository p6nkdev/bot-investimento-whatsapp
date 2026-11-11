FROM node:22-bookworm-slim

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 4738

CMD ["node", "index.js"]
