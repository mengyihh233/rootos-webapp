# ROOT-OS · 微信云托管（CloudBase Run）部署镜像
# 云托管按此 Dockerfile 自动构建：安装依赖 → 启动 Express（网页 + API 一个服务）
FROM node:20-slim

# 说明：better-sqlite3 有官方 prebuilt 二进制（npmmirror 提供），通常无需现场编译；
# 若个别环境出现编译失败，再取消下面两行注释（会显著拖慢构建，默认关闭）
# RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
#     && rm -rf /var/lib/apt/lists/*

# 国内 npm 镜像，加快构建（云托管构建机在腾讯云）
RUN npm config set registry https://registry.npmmirror.com

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# 云托管默认把流量打到容器 80 端口（控制台创建服务时端口填 80）
ENV NODE_ENV=production
ENV PORT=80

EXPOSE 80
CMD ["node", "server.js"]
