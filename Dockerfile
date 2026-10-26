# spider-kit Web 界面容器（离线构建版：依赖与 dist 在本机准备好，构建不碰网络）
FROM node:22-alpine

WORKDIR /app

# docker/deps/ = 本机 npm ci --omit=dev 的产物；docker/app/ = 源码 + dist
COPY docker/deps/node_modules ./node_modules
COPY docker/app/ .

ENV HOST=0.0.0.0 PORT=3210
VOLUME ["/app/output", "/app/storage"]
EXPOSE 3210

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O /dev/null http://127.0.0.1:3210/ || exit 1

CMD ["node", "dist/web.js"]
