#!/bin/sh

# 服务器端部署脚本 - 从源码构建并部署 krug-sites-project
# 使用方法：在服务器项目根目录执行此脚本
#   /root/opt/krug-sites-project/server-deploy.sh
#
# 可选环境变量：
#   SITES_PORT  服务对外端口（默认 3000）
#   BACKUP_ROOT 部署前数据库备份目录（默认 /root/krug-sites-backups）
#   BACKUP_KEEP 保留最近多少个 auth-db 备份（默认 30，设置 0 不清理）
#   模板文件默认写入 COS，需要提供 TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY / TENCENT_COS_REGION / TENCENT_COS_BUCKET

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

cecho() {
    printf "%b\n" "$1"
}

cecho "${GREEN}======================================${NC}"
cecho "${GREEN}  krug-sites-project 部署脚本${NC}"
cecho "${GREEN}  从源码构建并部署站点服务${NC}"
cecho "${GREEN}======================================${NC}"
echo ""

# 检查是否在正确的目录
if [ ! -f "docker-compose.prod.yml" ]; then
    cecho "${RED}❌ 错误：请在项目根目录执行此脚本${NC}"
    cecho "${YELLOW}正确路径：/root/opt/krug-sites-project${NC}"
    exit 1
fi

# 检查源码是否存在
if [ ! -f "package.json" ]; then
    cecho "${RED}❌ 错误：找不到 package.json${NC}"
    exit 1
fi

# 检查 Dockerfile
if [ ! -f "Dockerfile" ]; then
    cecho "${RED}❌ 错误：找不到 Dockerfile${NC}"
    exit 1
fi

# 检查托管部署 D1 配置和自托管数据库目录
if [ ! -f ".openai/hosting.json" ] || ! grep -q '"d1": "DB"' .openai/hosting.json; then
    cecho "${RED}❌ 错误：D1 数据库绑定未配置为 DB${NC}"
    cecho "${YELLOW}请确认 .openai/hosting.json 包含：\"d1\": \"DB\"${NC}"
    exit 1
fi

if [ ! -f "drizzle/0000_auth.sql" ]; then
    cecho "${RED}❌ 错误：找不到 D1 数据库迁移 drizzle/0000_auth.sql${NC}"
    exit 1
fi

if [ -f ".env" ]; then
    set -a
    . ./.env
    set +a
fi

if [ -z "${TENCENT_COS_SECRET_ID:-}" ] && [ -n "${COS_SECRET_ID:-}" ]; then
    export TENCENT_COS_SECRET_ID="$COS_SECRET_ID"
fi
if [ -z "${TENCENT_COS_SECRET_KEY:-}" ] && [ -n "${COS_SECRET_KEY:-}" ]; then
    export TENCENT_COS_SECRET_KEY="$COS_SECRET_KEY"
fi
if [ -z "${TENCENT_COS_REGION:-}" ] && [ -n "${COS_REGION:-}" ]; then
    export TENCENT_COS_REGION="$COS_REGION"
fi
if [ -z "${TENCENT_COS_BUCKET:-}" ] && [ -n "${COS_BUCKET:-}" ]; then
    export TENCENT_COS_BUCKET="$COS_BUCKET"
fi
if [ -z "${TENCENT_COS_BASE_PATH:-}" ] && [ -n "${COS_PREFIX:-}" ]; then
    export TENCENT_COS_BASE_PATH="$COS_PREFIX"
fi
if [ -z "${TENCENT_COS_PROJECT_PREFIX:-}" ] && [ -n "${COS_PROJECT_PREFIX:-}" ]; then
    export TENCENT_COS_PROJECT_PREFIX="$COS_PROJECT_PREFIX"
fi
if [ -z "${TENCENT_COS_CDN_DOMAIN:-}" ] && [ -n "${COS_CDN_DOMAIN:-}" ]; then
    export TENCENT_COS_CDN_DOMAIN="$COS_CDN_DOMAIN"
fi

cecho "${GREEN}✅ 源码检查通过${NC}"
cecho "${GREEN}✅ 数据库配置检查通过${NC}"
echo ""

if [ "${TEMPLATE_STORAGE_PROVIDER:-cos}" = "cos" ]; then
    export TENCENT_COS_ENV_PREFIX=prod
    missing_cos=0
    for key in TENCENT_COS_SECRET_ID TENCENT_COS_SECRET_KEY TENCENT_COS_REGION TENCENT_COS_BUCKET; do
        eval "cos_value=\${$key:-}"
        if [ -z "$cos_value" ]; then
            cecho "${RED}❌ 错误：TEMPLATE_STORAGE_PROVIDER=cos 但缺少 $key${NC}"
            missing_cos=1
        fi
    done
    if [ "$missing_cos" -ne 0 ]; then
        cecho "${YELLOW}请在服务器 .env 或当前 shell 中补齐 COS 配置后重新部署。${NC}"
        exit 1
    fi
    cecho "${GREEN}✅ COS 模板存储配置检查通过${NC}"
fi

cecho "${YELLOW}模板存储：${TEMPLATE_STORAGE_PROVIDER:-cos}${NC}"
if [ "${TEMPLATE_STORAGE_PROVIDER:-cos}" = "cos" ]; then
    cecho "${YELLOW}COS 路径前缀：${TENCENT_COS_PROJECT_PREFIX:-calendar}/${TENCENT_COS_ENV_PREFIX:-prod}/${TENCENT_COS_BASE_PATH:-uploads/}${NC}"
fi

cecho "${YELLOW}准备重新部署站点服务...${NC}"
cecho "${YELLOW}账号数据会保存在 Docker 卷 sites-auth-data-prod 中，除非手动删除该卷。${NC}"
echo ""

if [ -f "scripts/backup-auth-db-volume.sh" ]; then
    echo ""
    cecho "${GREEN}[1/4] 备份账号与模板索引数据库...${NC}"
    COMPOSE_PROJECT=krug-sites-project \
    BACKUP_ROOT="${BACKUP_ROOT:-/root/krug-sites-backups}" \
    BACKUP_KEEP="${BACKUP_KEEP:-30}" \
    sh scripts/backup-auth-db-volume.sh
else
    cecho "${YELLOW}⚠️ 未找到 scripts/backup-auth-db-volume.sh，跳过部署前备份${NC}"
fi

# 重新构建镜像
echo ""
cecho "${GREEN}[2/4] 构建 Docker 镜像（从源码构建）...${NC}"
docker-compose -p krug-sites-project -f docker-compose.prod.yml build --no-cache sites

# 启动或滚动更新服务。不要使用 down，避免影响同机其他 Compose 项目。
echo ""
cecho "${GREEN}[3/4] 启动/更新服务...${NC}"
docker-compose -p krug-sites-project -f docker-compose.prod.yml up -d --no-deps sites

# 等待服务启动
echo ""
cecho "${GREEN}[4/4] 等待服务启动...${NC}"
sleep 10

# 检查服务状态
echo ""
cecho "${GREEN}======================================${NC}"
cecho "${GREEN}  服务状态${NC}"
cecho "${GREEN}======================================${NC}"
docker-compose -p krug-sites-project -f docker-compose.prod.yml ps

echo ""
cecho "${YELLOW}📋 查看日志：${NC}"
echo "   docker logs -f krug-sites-prod"
echo ""
cecho "${YELLOW}🗄️ 数据库：${NC}"
echo "   OpenAI Sites/Cloudflare 使用 D1；Docker 自托管使用 /app/data/auth-db.json（volume: sites-auth-data-prod）"
echo "   部署前备份：${BACKUP_ROOT:-/root/krug-sites-backups}/auth-db-YYYYmmdd-HHMMSS.json"
echo ""
cecho "${YELLOW}📄 模板存储：${NC}"
if [ "${TEMPLATE_STORAGE_PROVIDER:-cos}" = "cos" ]; then
    echo "   Tencent COS: ${TENCENT_COS_BUCKET}/${TENCENT_COS_PROJECT_PREFIX:-calendar}/${TENCENT_COS_ENV_PREFIX:-prod}/${TENCENT_COS_BASE_PATH:-uploads/}"
else
    echo "   Local volume: /app/data/templates（volume: sites-auth-data-prod）"
fi
echo ""
cecho "${YELLOW}🌐 访问地址：${NC}"
echo "   http://YOUR_SERVER_IP:${SITES_PORT:-3000}"
echo ""
cecho "${GREEN}✅ 部署完成！${NC}"
