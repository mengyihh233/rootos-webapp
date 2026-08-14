# ROOT-OS · 微信云托管（CloudBase Run）部署镜像
# 云托管按此 Dockerfile 自动构建：安装依赖 → 启动 Express（网页 + API 一个服务）
# 🔴 用完整版 node:20（自带 python3/make/g++）：better-sqlite3 的 prebuilt 从 GitHub
# 下载（国内常失败）→ 自动 fallback node-gyp 现场编译 → slim 镜像无工具链必失败
FROM node:20

# 国内 npm 镜像，加快构建（云托管构建机在腾讯云）
RUN npm config set registry https://registry.npmmirror.com

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# 云托管默认把流量打到容器 80 端口（控制台创建服务时端口填 80）
ENV NODE_ENV=production
# 云托管跑在 LB 之后：启用 trust proxy（secure cookie 依赖 X-Forwarded-Proto）
ENV TRUST_PROXY=1
ENV PORT=80

EXPOSE 80
CMD ["node", "server.js"]
