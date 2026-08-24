#!/bin/bash

# 服务器端部署脚本 - 从源码构建并部署 krug-sites-project
# 使用方法：在服务器项目根目录执行此脚本
#   /root/opt/krug-sites-project/server-deploy.sh
#
# 可选环境变量：
#   SITES_PORT  服务对外端口（默认 3000）
#   模板文件默认写入 COS，需要提供 TENCENT_COS_SECRET_ID / TENCENT_COS_SECRET_KEY / TENCENT_COS_REGION / TENCENT_COS_BUCKET

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}  krug-sites-project 部署脚本${NC}"
echo -e "${GREEN}  从源码构建并部署站点服务${NC}"
echo -e "${GREEN}======================================${NC}"
echo ""

# 检查是否在正确的目录
if [ ! -f "docker-compose.prod.yml" ]; then
    echo -e "${RED}❌ 错误：请在项目根目录执行此脚本${NC}"
    echo -e "${YELLOW}正确路径：/root/opt/krug-sites-project${NC}"
    exit 1
fi

# 检查源码是否存在
if [ ! -f "package.json" ]; then
    echo -e "${RED}❌ 错误：找不到 package.json${NC}"
    exit 1
fi

# 检查 Dockerfile
if [ ! -f "Dockerfile" ]; then
    echo -e "${RED}❌ 错误：找不到 Dockerfile${NC}"
    exit 1
fi

# 检查托管部署 D1 配置和自托管数据库目录
if [ ! -f ".openai/hosting.json" ] || ! grep -q '"d1": "DB"' .openai/hosting.json; then
    echo -e "${RED}❌ 错误：D1 数据库绑定未配置为 DB${NC}"
    echo -e "${YELLOW}请确认 .openai/hosting.json 包含：\"d1\": \"DB\"${NC}"
    exit 1
fi

if [ ! -f "drizzle/0000_auth.sql" ]; then
    echo -e "${RED}❌ 错误：找不到 D1 数据库迁移 drizzle/0000_auth.sql${NC}"
    exit 1
fi

if [ -f ".env" ]; then
    set -a
    . ./.env
    set +a
fi

echo -e "${GREEN}✅ 源码检查通过${NC}"
echo -e "${GREEN}✅ 数据库配置检查通过${NC}"
echo ""

if [ "${TEMPLATE_STORAGE_PROVIDER:-cos}" = "cos" ]; then
    export TENCENT_COS_ENV_PREFIX=prod
    missing_cos=0
    for key in TENCENT_COS_SECRET_ID TENCENT_COS_SECRET_KEY TENCENT_COS_REGION TENCENT_COS_BUCKET; do
        if [ -z "${!key}" ]; then
            echo -e "${RED}❌ 错误：TEMPLATE_STORAGE_PROVIDER=cos 但缺少 $key${NC}"
            missing_cos=1
        fi
    done
    if [ "$missing_cos" -ne 0 ]; then
        echo -e "${YELLOW}请在服务器 .env 或当前 shell 中补齐 COS 配置后重新部署。${NC}"
        exit 1
    fi
    echo -e "${GREEN}✅ COS 模板存储配置检查通过${NC}"
fi

echo -e "${YELLOW}模板存储：${TEMPLATE_STORAGE_PROVIDER:-cos}${NC}"
if [ "${TEMPLATE_STORAGE_PROVIDER:-cos}" = "cos" ]; then
    echo -e "${YELLOW}COS 路径前缀：${TENCENT_COS_PROJECT_PREFIX:-calendar}/${TENCENT_COS_ENV_PREFIX:-prod}/${TENCENT_COS_BASE_PATH:-uploads/}${NC}"
fi

echo -e "${YELLOW}准备重新部署站点服务...${NC}"
echo -e "${YELLOW}账号数据会保存在 Docker 卷 sites-auth-data-prod 中，除非手动删除该卷。${NC}"
echo ""

# 重新构建镜像
echo ""
echo -e "${GREEN}[1/3] 构建 Docker 镜像（从源码构建）...${NC}"
docker-compose -p krug-sites-project -f docker-compose.prod.yml build --no-cache sites

# 启动或滚动更新服务。不要使用 down，避免影响同机其他 Compose 项目。
echo ""
echo -e "${GREEN}[2/3] 启动/更新服务...${NC}"
docker-compose -p krug-sites-project -f docker-compose.prod.yml up -d --no-deps sites

# 等待服务启动
echo ""
echo -e "${GREEN}[3/3] 等待服务启动...${NC}"
sleep 10

# 检查服务状态
echo ""
echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}  服务状态${NC}"
echo -e "${GREEN}======================================${NC}"
docker-compose -p krug-sites-project -f docker-compose.prod.yml ps

echo ""
echo -e "${YELLOW}📋 查看日志：${NC}"
echo "   docker logs -f krug-sites-prod"
echo ""
echo -e "${YELLOW}🗄️ 数据库：${NC}"
echo "   OpenAI Sites/Cloudflare 使用 D1；Docker 自托管使用 /app/data/auth-db.json（volume: sites-auth-data-prod）"
echo ""
echo -e "${YELLOW}📄 模板存储：${NC}"
if [ "${TEMPLATE_STORAGE_PROVIDER:-cos}" = "cos" ]; then
    echo "   Tencent COS: ${TENCENT_COS_BUCKET}/${TENCENT_COS_PROJECT_PREFIX:-calendar}/${TENCENT_COS_ENV_PREFIX:-prod}/${TENCENT_COS_BASE_PATH:-uploads/}"
else
    echo "   Local volume: /app/data/templates（volume: sites-auth-data-prod）"
fi
echo ""
echo -e "${YELLOW}🌐 访问地址：${NC}"
echo "   http://YOUR_SERVER_IP:${SITES_PORT:-3000}"
echo ""
echo -e "${GREEN}✅ 部署完成！${NC}"
