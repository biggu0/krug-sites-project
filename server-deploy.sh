#!/bin/bash

# 服务器端部署脚本 - 从源码构建并部署 krug-sites-project
# 使用方法：在服务器项目根目录执行此脚本
#   /root/opt/krug-sites-project/server-deploy.sh
#
# 可选环境变量：
#   SITES_PORT  服务对外端口（默认 3000）

set -e

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}  krug-sites-project 部署脚本${NC}"
echo -e "${GREEN}  从源码构建并部署站点服务（含 Cloudflare D1 本地数据库）${NC}"
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

# 检查 D1 数据库配置
if [ ! -f ".openai/hosting.json" ] || ! grep -q '"d1": "DB"' .openai/hosting.json; then
    echo -e "${RED}❌ 错误：D1 数据库绑定未配置为 DB${NC}"
    echo -e "${YELLOW}请确认 .openai/hosting.json 包含：\"d1\": \"DB\"${NC}"
    exit 1
fi

if [ ! -f "drizzle/0000_auth.sql" ]; then
    echo -e "${RED}❌ 错误：找不到 D1 数据库迁移 drizzle/0000_auth.sql${NC}"
    exit 1
fi

echo -e "${GREEN}✅ 源码检查通过${NC}"
echo -e "${GREEN}✅ D1 数据库配置检查通过${NC}"
echo ""

echo -e "${YELLOW}准备重新部署站点服务...${NC}"
echo -e "${YELLOW}账号数据会保存在 Docker 卷 sites-d1-data-prod 中，除非手动删除该卷。${NC}"
echo ""

# 停止旧服务
echo -e "${GREEN}[1/4] 停止旧服务...${NC}"
docker-compose -f docker-compose.prod.yml down --remove-orphans

# 重新构建镜像
echo ""
echo -e "${GREEN}[2/4] 构建 Docker 镜像（从源码构建）...${NC}"
docker-compose -f docker-compose.prod.yml build --no-cache sites

# 启动服务
echo ""
echo -e "${GREEN}[3/4] 启动服务...${NC}"
docker-compose -f docker-compose.prod.yml up -d sites

# 等待服务启动
echo ""
echo -e "${GREEN}[4/4] 等待服务启动...${NC}"
sleep 10

# 检查服务状态
echo ""
echo -e "${GREEN}======================================${NC}"
echo -e "${GREEN}  服务状态${NC}"
echo -e "${GREEN}======================================${NC}"
docker-compose -f docker-compose.prod.yml ps

echo ""
echo -e "${YELLOW}📋 查看日志：${NC}"
echo "   docker logs -f krug-sites-prod"
echo ""
echo -e "${YELLOW}🗄️ 数据库：${NC}"
echo "   Cloudflare D1（本地 Docker 部署时保存在 Docker volume: sites-d1-data-prod）"
echo ""
echo -e "${YELLOW}🌐 访问地址：${NC}"
echo "   http://YOUR_SERVER_IP:${SITES_PORT:-3000}"
echo ""
echo -e "${GREEN}✅ 部署完成！${NC}"
