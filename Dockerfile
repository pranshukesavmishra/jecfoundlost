FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8080
ENV PORT=8080
# Run node directly (not via npm) so it receives SIGTERM and can save pending data before shutdown.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
