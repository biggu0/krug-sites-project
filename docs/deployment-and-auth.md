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

## admin 创建后如何登录

首次打开系统时，如果账号库里还没有用户，页面标题会显示“创建管理员账号”。这一步提交后会自动创建 `admin` 并写入登录 cookie。

如果创建后又回到“登录系统”页面，直接使用刚创建的用户名和密码登录：

```text
用户名：admin
密码：创建管理员时输入的密码
```

如果登录后还是停留在登录页，优先检查这几项：

- 服务器是否已经部署最新代码，旧版本曾经会因为 cookie `Secure` 配置导致 HTTP 站点无法保存登录状态。
- 本地和 Docker 环境里 `AUTH_COOKIE_SECURE` 应该是 `"false"`；如果站点已经通过 HTTPS 访问，可以改为 `"true"`。
- 账号数据 volume 是否被清空。如果 `auth-db.json` 丢失，系统会重新进入“创建管理员账号”流程。

## 增加或重置账号

Docker 自托管环境可以用脚本直接创建测试账号，脚本会保留模板和组织数据，并在写入前备份 `auth-db.json`：

```bash
npm run accounts:upsert -- \
  --db /root/auth-db.json \
  --username test1 \
  --password '至少10位的新密码' \
  --permissions customization,templates \
  --organization-id org_default
```

如果用户名已存在，同一条命令会更新密码、权限和组织，并默认清掉该用户旧 session。

生产 volume 中操作时，建议先复制出来修改，再放回去：

```bash
docker run --rm \
  -v krug-sites-project_sites-auth-data-prod:/data \
  -v /root:/backup \
  alpine sh -c 'cp /data/auth-db.json /backup/auth-db.json'

npm run accounts:upsert -- \
  --db /root/auth-db.json \
  --username test1 \
  --password '至少10位的新密码' \
  --permissions customization,templates \
  --organization-id org_default

docker run --rm \
  -v krug-sites-project_sites-auth-data-prod:/data \
  -v /root:/backup \
  alpine sh -c 'cp /backup/auth-db.json /data/auth-db.json'

docker restart krug-sites-prod
```

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

## 模板维护与 COS 存储

模板维护已经从页面本地存储抽成服务端接口：

- `GET /api/templates`：读取模板列表。
- `POST /api/templates`：上传 PDF 模板。
- `PATCH /api/templates/:id`：更新模板名称、定制区域、单双面、奇偶页、旋转等参数。
- `DELETE /api/templates/:id`：删除模板。
- `GET /api/templates/:id/file`：读取模板 PDF。
- `POST /api/templates/:id/foreground`：上传前景保护 PDF。
- `GET /api/templates/:id/foreground`：读取前景保护 PDF。

模板文件统一写入腾讯云 COS。本地只保留为兜底 provider，不再作为默认模板存储。

```text
TEMPLATE_STORAGE_PROVIDER=cos
TENCENT_COS_SECRET_ID=
TENCENT_COS_SECRET_KEY=
TENCENT_COS_REGION=ap-guangzhou
TENCENT_COS_BUCKET=krug-product-cos-1382434240
TENCENT_COS_BASE_PATH=uploads/
TENCENT_COS_PROJECT_PREFIX=calendar
```

本地 Vinext/Cloudflare 开发环境如果没有设置 COS 变量，会自动使用 `database` 后备存储，避免 Worker 运行时写 `node:fs` 失败。远程已有完整 COS 变量时仍自动使用 COS，无需重新配置；显式设置 `TEMPLATE_STORAGE_PROVIDER` 时始终以该值为准。

本地环境使用：

```text
TENCENT_COS_ENV_PREFIX=test
```

线上环境使用：

```text
TENCENT_COS_ENV_PREFIX=prod
```

配置含义参考 `krug-management` 的 `tencent.cos.*`。密钥只放在服务器或本机 `.env`，不要提交到代码仓库。

兼容旧变量名：`COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_REGION`、`COS_BUCKET`、`COS_PREFIX`、`COS_ENV_PREFIX`、`COS_PROJECT_PREFIX`、`COS_CDN_DOMAIN`。

COS 模式下：

- 模板 PDF 写入 `PROJECT_PREFIX/ENV_PREFIX/BASE_PATH/{templateId}/{fileName}`，默认路径类似 `calendar/test/uploads/{templateId}/{fileName}`。
- 前景保护 PDF 写入同一个模板目录。
- 模板索引、组织归属、区域参数、单双面、页数、旋转等元数据写入账号/模板数据库；Docker 自托管时就是 `/app/data/auth-db.json`。
- `database` 后备 provider 才会把 PDF 内容写入数据库表 `template_objects`；生产 COS 模式只把 PDF 文件写入 COS。
- 删除模板时会删除 COS 文件对象并更新索引。
- 前端仍通过 `/api/templates/:id/file` 和 `/api/templates/:id/foreground` 读取，密钥不会暴露给浏览器。

本地用 Worker 运行时：

```bash
npm run build
npm run start:worker
```

`start:worker` 会读取本机 `.env`，生成 `dist/server/wrangler.local.json`，再把 COS 配置注入 Wrangler 的 `vars`。原因是 `dist/server/wrangler.json` 是构建产物，默认 `vars` 为空；只在外层 shell 加 env 时，Worker 运行时不一定能读到这些配置。

## 当前部署方式

### 自托管 Docker 部署

在服务器项目目录执行：

```bash
cd /root/opt/krug-sites-project
./server-deploy.sh
```

部署脚本会读取项目目录下的 `.env`。生产脚本会强制模板前缀为 `calendar/prod/uploads/`，本地 `start:worker` 默认使用 `calendar/test/uploads/`。

部署脚本会：

1. 检查项目文件、D1 绑定和迁移文件。
2. 部署前备份 Docker volume 里的 `/app/data/auth-db.json`。
3. 构建 Docker 镜像。
4. 使用固定 Compose 项目名 `krug-sites-project` 更新当前服务。
5. 不再执行 `docker-compose down --remove-orphans`，避免误停同机其他项目。

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

部署脚本会自动备份账号、组织和模板索引数据：

```text
/root/krug-sites-backups/auth-db-YYYYmmdd-HHMMSS.json
```

可选参数：

```bash
BACKUP_ROOT=/data/krug-sites-backups BACKUP_KEEP=60 ./server-deploy.sh
```

也可以手动备份：

```bash
COMPOSE_PROJECT=krug-sites-project BACKUP_ROOT=/root/krug-sites-backups sh scripts/backup-auth-db-volume.sh
```

恢复账号数据：

```bash
docker run --rm \
  -v krug-sites-project_sites-auth-data-prod:/data \
  -v /root/krug-sites-backups:/backup \
  alpine sh -c 'cp /backup/auth-db-YYYYmmdd-HHMMSS.json /data/auth-db.json'

docker restart krug-sites-prod
```

如果账号库里的模板索引已经丢失，但 COS 上的 PDF 文件还在，可以用 COS 对象列表 CSV 重建模板索引：

```bash
npm run templates:restore-cos -- \
  --csv /root/cos-object-list.csv \
  --db /root/auth-db.json \
  --prefix calendar/prod/uploads/
```

确认输出的 `Prepared / inserted / skipped` 数量正确后再写入：

```bash
npm run templates:restore-cos -- \
  --csv /root/cos-object-list.csv \
  --db /root/auth-db.json \
  --prefix calendar/prod/uploads/ \
  --apply
```

脚本只恢复索引和默认区域参数；如果原来的精细区域参数没有备份，恢复后需要在模板管理页面重新微调。生产 Docker volume 可以先把文件复制出来恢复，再放回 volume：

```bash
docker run --rm \
  -v krug-sites-project_sites-auth-data-prod:/data \
  -v /root:/backup \
  alpine sh -c 'cp /data/auth-db.json /backup/auth-db.json'

npm run templates:restore-cos -- \
  --csv /root/cos-object-list.csv \
  --db /root/auth-db.json \
  --prefix calendar/prod/uploads/ \
  --apply

docker run --rm \
  -v krug-sites-project_sites-auth-data-prod:/data \
  -v /root:/backup \
  alpine sh -c 'cp /backup/auth-db.json /data/auth-db.json'

docker restart krug-sites-prod
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
- 部署脚本已经增加部署前备份；仍建议服务器额外配置定时备份，并把备份同步到另一块盘或对象存储。
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
{"setupRequired": true, "user": null}
```
