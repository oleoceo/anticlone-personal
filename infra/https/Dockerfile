FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY apps ./apps
COPY tests ./tests
RUN npm run build && npm prune --omit=dev
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/apps ./dist/apps
COPY package.json ./
COPY runtime ./runtime
USER node
CMD ["node", "dist/apps/server.js"]
