FROM node:22-alpine AS build

RUN apk add --no-cache git bash

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi

COPY tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine

RUN apk add --no-cache git bash

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi \
  && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY plugins ./plugins
RUN mkdir -p scripts
COPY scripts/postinstall.mjs ./scripts/postinstall.mjs

RUN adduser -D -u 1001 nordrelay \
  && mkdir -p /workspace /home/nordrelay/.nordrelay \
  && chown -R nordrelay:nordrelay /workspace /home/nordrelay

USER nordrelay

CMD ["node", "dist/index.js"]
