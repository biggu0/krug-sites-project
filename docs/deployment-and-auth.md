# JHT 图片处理系统部署与账号数据库说明

## 当前架构

这个项目是 Vinext/Next 风格的前端应用，构建后可以运行在两类环境：

- OpenAI Sites / Cloudflare Workers：使用 Cloudflare D1 作为账号数据库。
- 自托管 Docker / 普通 Node 服务：使用本地持久化文件 `/app/data/auth-db.json` 保存账号数据。

账号系统涉及这些文件：

- `app/AuthGate.tsx`：登录入口、首次初始化管理员账号。
- `app/AccountManagement.tsx`：账号管理、权限分配。
- `app/api/_auth.ts`：账号、权限、session 的服务端存储和校验。
- `app/api/auth/*`：登录、退出、初始化、状态查询接口。
- `app/api/accounts/route.ts`：账号增删改查接口。
- `.openai/hosting.json`：OpenAI Sites 的 D1 逻辑绑定，当前为 `"d1": "DB"`。
- `drizzle/0000_auth.sql`：OpenAI Sites/Cloudflare 部署时使用的数据库迁移。
- `db/schema.sql`：数据库结构参考。

## 数据库技术

托管环境使用 **Cloudflare D1**。D1 是 Cloudflare Workers 上的 SQLite 兼容数据库，适合保存结构化数据，比如用户、权限、session。

自托管 Docker 环境没有 Cloudflare Workers 的 `env.DB` 绑定，所以当前实现会自动降级为本地文件数据库：

```text
/app/data/auth-db.json
```

这个文件通过 Docker volume 持久化：

```text
sites-auth-data-prod:/app/data
```

因此容器重建不会丢账号；只有手动删除 Docker volume 才会清空账号数据。


## 当前部署方式

### 自托管 Docker 部署

在服务器项目目录执行：

```bash
cd /root/opt/krug-sites-project
./server-deploy.sh
```

部署脚本会：

1. 检查项目文件、D1 绑定和迁移文件。
2. 构建 Docker 镜像。
3. 使用固定 Compose 项目名 `krug-sites-project` 更新当前服务。
4. 不再执行 `docker-compose down --remove-orphans`，避免误停同机其他项目。

当前服务默认端口：

```bash
SITES_PORT=3000
```

如果要改端口：

```bash
SITES_PORT=3010 ./server-deploy.sh
```

### 查看日志

```bash
docker logs -f krug-sites-prod
```

### 查看服务状态

```bash
docker-compose -p krug-sites-project -f docker-compose.prod.yml ps
```

### 账号数据位置

容器内：

```text
/app/data/auth-db.json
```

Docker volume：

```text
krug-sites-project_sites-auth-data-prod
```

查看 volume：

```bash
docker volume ls | grep sites-auth-data
```

备份账号数据：

```bash
docker run --rm \
  -v krug-sites-project_sites-auth-data-prod:/data \
  -v "$PWD":/backup \
  alpine sh -c 'cp /data/auth-db.json /backup/auth-db.backup.json'
```

恢复账号数据：

```bash
docker run --rm \
  -v krug-sites-project_sites-auth-data-prod:/data \
  -v "$PWD":/backup \
  alpine sh -c 'cp /backup/auth-db.backup.json /data/auth-db.json'
```

## OpenAI Sites / Cloudflare 部署

构建：

```bash
npm run build
```

生成部署包：

```bash
npm run sites:package
```

部署包需要包含：

```text
dist/server/index.js
dist/.openai/hosting.json
dist/.openai/drizzle/0000_auth.sql
```

当前 `.openai/hosting.json`：

```json
{
  "project_id": "appgprj_6a8a89dfa780819193cac7f285b921d7",
  "d1": "DB",
  "r2": null
}
```

## 快速恢复步骤

如果服务器刚部署后服务异常：

1. 先看当前服务日志：

```bash
docker logs --tail=200 krug-sites-prod
```

2. 如果看到 `workerd ENOENT`，说明服务器还在跑旧镜像或旧代码。拉取最新代码后重新部署：

```bash
cd /root/opt/krug-sites-project
git pull
./server-deploy.sh
```

3. 如果另一个项目也停了，进入另一个项目目录单独拉起：

```bash
cd /path/to/other-project
docker-compose up -d
```

4. 检查两个项目是否都在运行：

```bash
docker ps
```

## 后续优化步骤

### P0：部署安全

- 每个 Docker Compose 项目都显式指定 `-p <project-name>`，避免项目之间网络、volume、orphan 容器互相影响。
- 部署脚本不要使用 `down --remove-orphans`，生产环境优先使用 `up -d --no-deps <service>` 原地更新。
- 服务器上为每个项目固定端口，避免端口冲突。

### P1：数据库可靠性

- 自托管长期建议换成真正 SQLite 文件数据库，而不是 JSON 文件模拟层。
- 如果服务器已经有 PostgreSQL/MySQL，也可以改为集中数据库。
- 给账号数据增加定时备份，例如每天备份 `auth-db.json`。
- 管理员账号创建后，限制再次访问初始化接口。

### P2：安全增强

- 如果生产站点通过 HTTPS 访问，把 `AUTH_COOKIE_SECURE` 改为 `"true"`。
- session 增加定期清理过期记录。
- 登录失败增加频率限制，防止暴力尝试密码。
- 后台账号管理增加修改密码入口和操作日志。

### P3：代码质量

- 整理 `app/api/_auth.ts`，把 D1 存储和自托管存储拆成独立模块。
- 修复现有 ESLint 报错，尤其是 `any` 和 React hooks 规则。
- 给登录、初始化、账号管理接口增加自动化测试。

## 验证命令

本地构建：

```bash
npm run build
```

Docker 构建：

```bash
docker-compose -p krug-sites-project -f docker-compose.prod.yml build sites
```

临时容器健康检查：

```bash
docker run --rm -d --name krug-sites-smoke -p 8794:3000 \
  -e AUTH_DB_PATH=/app/data/auth-db.json \
  -e AUTH_COOKIE_SECURE=false \
  krug-sites:latest

curl http://127.0.0.1:8794/api/auth/status

docker stop krug-sites-smoke
```

期望返回：

```json
{"setupRequired":true,"user":null}
```
