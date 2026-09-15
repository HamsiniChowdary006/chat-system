FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY api-service/package.json api-service/package.json
COPY chat-service/package.json chat-service/package.json
COPY shared/package.json shared/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY tsconfig.json ./
COPY api-service/ api-service/
COPY shared/ shared/
RUN npm run build --workspace api-service

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/api-service/dist ./api-service/dist
COPY --from=build /app/api-service/package.json ./api-service/package.json
COPY --from=build /app/shared/dist ./shared/dist
EXPOSE 3000
CMD ["node", "api-service/dist/index.js"]
