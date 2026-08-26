FROM node:24.19-alpine AS builder-stage

WORKDIR /app

# Copy package files first and install dependencies
COPY package.json package-lock.json ./
RUN npm install

# Then copy the rest of your application
COPY . .

ENTRYPOINT ["npx", "tsx", "index_16.ts"]