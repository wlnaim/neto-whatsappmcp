# Etapa 1: compilar TypeScript y dejar solo dependencias de produccion
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && rm -rf dist/tests && npm prune --omit=dev

# Etapa 2: imagen final minima, sin secretos (todo llega por variables de entorno)
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV RUNNING_IN_CONTAINER=1
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
USER node
EXPOSE 8787
ENTRYPOINT ["node","dist/index.js"]
