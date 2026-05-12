FROM node:22-alpine

RUN apk add --no-cache git bash

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run build

RUN adduser -D -u 1001 nordrelay \
  && mkdir -p /workspace /home/nordrelay/.codex \
  && chown -R nordrelay:nordrelay /workspace /home/nordrelay

USER nordrelay

CMD ["node", "dist/index.js"]
