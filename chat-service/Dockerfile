FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY api-service/package.json api-service/package.json
COPY chat-service/package.json chat-service/package.json
COPY shared/package.json shared/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY tsconfig.json ./
COPY chat-service/ chat-service/
COPY shared/ shared/
RUN npm run build --workspace chat-service

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/chat-service/dist ./chat-service/dist
COPY --from=build /app/chat-service/package.json ./chat-service/package.json
COPY --from=build /app/shared/dist ./shared/dist
EXPOSE 4000
CMD ["node", "chat-service/dist/index.js"]
