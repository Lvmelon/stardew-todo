# 今日任务 · 像素田园待办

给两个人使用的轻量级、治愈系像素田园 PWA。它像小镇公告板上的委托，而不是企业 Todo 工具。

线上地址：<https://lvmelon.github.io/stardew-todo/>

## 产品边界

V1.0 采用“任务本地存储 + 云端共享镜像”，不是完整的多设备 Todo 同步：

- 每台设备的 IndexedDB 是该设备任务的主数据源，创建、编辑、完成、删除先在本地完成。
- Cloudflare Worker + D1 只保存共享所需的最小任务镜像，让另一方查看任务状态、查看详情和留言，并支持任务拥有者的后台提醒。
- 任务拥有者可以管理自己的任务；另一方默认只能查看和留言，不能修改标题、日期或完成状态。
- 断网或 Worker 不可用时，本机 Todo 仍应可用；失败的镜像更新以轻量 `pendingShareSync` 标记，在打开应用、网络恢复或手动刷新时重试。
- 不做账号、密码、验证码、完整双向同步、LWW 冲突系统、全量设置云同步或聊天系统。

具体需求、数据边界和验收标准见 [`PRD.md`](./PRD.md)；数据流和接口见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 已确认的静态 PWA 基线

当前仓库已经具备或曾经验证过的 V0.5 基线包括：

- 像素田园任务公告板；
- 新增、查看、编辑、软删除和完成任务；
- 完成后任务从开放任务板消失，并有轻量星光反馈；
- IndexedDB 本地持久化，失败时降级到 localStorage，再降级到内存；
- Service Worker 应用壳缓存；
- Web App Manifest、Apple 主屏幕图标和 GitHub Pages 项目子路径兼容。

截至 2026-08-25，V1.0 前端已发布到 <https://lvmelon.github.io/stardew-todo/>，Worker 已部署到 <https://stardew-todo-worker.stardew-todo.workers.dev>。远端 D1 migration、VAPID Secrets、Cron trigger、健康检查、配对、共享镜像、伙伴只读权限、留言、CORS 和 GitHub Actions 自动部署已通过线上验收。iPhone/PC 的系统通知展示仍需真实设备授权与到达测试，不能由 API 成功外推。

## 本地运行

前端不需要构建步骤。使用任意静态 HTTPS/HTTP 开发服务器从仓库根目录提供文件，例如：

```powershell
python -m http.server 4173
```

然后访问 <http://localhost:4173/>。Service Worker、通知和 Web Crypto 的部分能力需要安全上下文（HTTPS；localhost 通常例外）。Worker 后端的本地开发、D1 迁移和 Secrets 见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)。

## GitHub Pages 部署

当前 Pages 目标是 `main` 分支根目录，项目站点路径为 `/stardew-todo/`。静态资源使用相对路径，不要把根域名 `/assets/...` 写进前端。

部署步骤和发布后核验见 [`GITHUB-PAGES-DEPLOY.md`](./GITHUB-PAGES-DEPLOY.md)。Cloudflare Worker 是独立的后端发布单元，不能因为 Pages 发布成功就认为 Worker 或 Cron 已部署。

## 数据与隐私提醒

- 本地任务、设置、设备凭据和备份由浏览器站点数据管理；清除站点数据或更换设备可能丢失本地主数据。
- 使用共享空间时，D1 只保存共享任务镜像、留言、空间/成员授权摘要和 Web Push 所需数据，不保存天气、BGM、动画等纯本地设置。
- 配对链接和恢复码是 bearer capability：拿到它的人可能加入空间。它们不放在 URL query、日志或分析事件中；链接只通过 URL fragment 传递，读取后立即清理地址栏。
- 当前仓库只包含公开 Worker URL 和 D1 binding ID，不包含 Cloudflare token、VAPID 私钥或空间凭据。提交前检查 `.env.example` 之外的文件；真实密钥通过 `wrangler secret` 和 GitHub Actions Secrets 注入。

安全边界、威胁模型和事件处理见 [`SECURITY.md`](./SECURITY.md)。

## 文档索引

| 文档 | 用途 |
| --- | --- |
| [`PRD.md`](./PRD.md) | V1.0 产品范围、用户流程、数据权威和验收标准 |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 前端、Worker、D1、镜像、留言、Push 和 Cron 的技术设计 |
| [`SECURITY.md`](./SECURITY.md) | 配对凭据、权限、隐私、Push 和运维安全 |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md) | Pages、Worker、D1、Secrets、CI 和发布核验 |
| [`GITHUB-PAGES-DEPLOY.md`](./GITHUB-PAGES-DEPLOY.md) | 静态站点的实际 Pages 操作步骤 |
| [`CREDITS.md`](./CREDITS.md) | 素材、标准、原创声音和版权边界 |
