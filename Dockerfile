FROM node:22-alpine
WORKDIR /app
COPY server.js index.html ./
ENV DATA_FILE=/data/state.json
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
