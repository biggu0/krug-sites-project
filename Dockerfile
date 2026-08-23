# 构建阶段
FROM node:22-alpine AS builder

WORKDIR /app

# 复制 package 文件，安装全部依赖（构建需要 devDependencies）
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码并构建
COPY . .
RUN npm run build

# 运行阶段
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# 仅复制运行所需文件
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 复制构建产物与源码（vinext start 需要源码 + 构建产物）
COPY --from=builder /app/.vinext ./.vinext
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/app ./app
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/vite.config.ts ./vite.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/eslint.config.mjs ./eslint.config.mjs
COPY --from=builder /app/.openai ./.openai

EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["npm", "run", "start"]
