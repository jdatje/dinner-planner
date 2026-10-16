FROM node:22-alpine
WORKDIR /app
COPY server.js index.html ./
COPY icons ./icons
ENV DATA_FILE=/data/state.json
ENV HOST=0.0.0.0
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
