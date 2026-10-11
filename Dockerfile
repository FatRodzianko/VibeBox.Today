FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["npm", "start"]
