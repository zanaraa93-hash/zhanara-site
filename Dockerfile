# syntax=docker/dockerfile:1

# node:sqlite (used by server/core/storage) needs Node 22.13+.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.mjs index.html admin.html ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY server ./server
COPY scripts ./scripts
COPY img ./img
COPY --from=build /app/dist ./dist
COPY uploads ./uploads

# Named volumes take ownership from these directories on first mount.
RUN mkdir -p data/logs data/backups && chown -R node:node data uploads
USER node

EXPOSE 3000
VOLUME ["/app/data", "/app/uploads"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/index.js"]
