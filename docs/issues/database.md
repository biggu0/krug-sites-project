## 为什么改数据库

新代码加入了登录和账号权限功能。原来的系统主要依赖浏览器本地状态，不需要服务端账号库；一旦增加“管理员账号、登录 session、账号权限”，就必须有一个服务端持久化存储。

一开始采用 D1，是因为项目带 `.openai/hosting.json`，OpenAI Sites/Cloudflare 部署天然支持 D1，部署包也支持带 `drizzle` 迁移文件。

后来部署到自托管 Docker 服务器时出现问题：

```text
spawn /app/node_modules/@cloudflare/workerd-linux-64/bin/workerd ENOENT
```

原因是当时把生产启动命令改成了 `wrangler dev`，它是 Cloudflare 本地开发运行时，需要 `workerd` 二进制，不适合作为普通服务器的生产启动方式。并且普通 Node 服务也没有 `cloudflare:workers` 的 `env.DB`。

所以现在改成双模式：

- Sites/Cloudflare：继续使用 D1。
- Docker/Node：使用本地持久化账号文件，避免依赖 `workerd`，保证服务器稳定启动。