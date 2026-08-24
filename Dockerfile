# 构建阶段
FROM node:22-alpine AS builder

WORKDIR /app

# 复制 package 文件，安装全部依赖（构建需要 devDependencies）
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码并构建（构建产物输出到 dist/）
COPY . .
RUN npm run build

# 运行阶段
# 注：vinext CLI 位于 devDependencies，但 `npm run start` 需要它，
# 因此 runner 阶段直接复用 builder 的完整 node_modules（含 pnpm 符号链接结构）。
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV WRANGLER_SEND_METRICS=false

# 复制运行所需文件：构建产物 + 依赖 + package.json（提供 start 脚本）
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/db ./db
COPY --from=builder /app/.openai ./.openai
COPY package.json ./

EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["npm", "run", "start"]
