# 今日任务 · 像素田园待办 V1.0 部署与运维

本项目有两个独立发布单元：

1. **GitHub Pages**：发布静态前端到 `main` 根目录，站点路径为 `/stardew-todo/`；
2. **Cloudflare Worker + D1**：提供共享任务镜像、留言、配对、Push 订阅、健康检查和 Cron。

Pages 发布成功不代表 Worker、D1、Secrets 或 Cron 已部署。截至 2026-08-25，生产 Worker <https://stardew-todo-worker.stardew-todo.workers.dev>、D1 migration、VAPID Secrets 和每分钟 Cron trigger 已部署；线上 health、配对、镜像、留言、角色权限与 CORS 已验收。系统 Push 是否最终显示仍需 iPhone/PC 真机授权与到达测试；GitHub Actions 自动部署还必须以仓库 Secrets 配置和首次 main run 为证。

## 1. 先确认 Git 状态

开发或发布前：

```powershell
git status --short --branch
git branch -vv
git diff --check
```

开发在 `feat/v1-complete` 等功能分支完成，测试通过后再合并 `main`。`main` 是线上 Pages 分支；不要把半成品推到 `main`，不要用 `git push` 成功替代 Pages 构建完成或线上资源已更新。

## 2. GitHub Pages（静态前端）

### 2.1 仓库设置

GitHub 仓库 `Settings` → `Pages` → `Build and deployment`：

1. Source：`Deploy from a branch`；
2. Branch：`main`；
3. Folder：`/(root)`；
4. 保存并等待 Pages 状态显示完成。

官方说明：[Configuring a publishing source for your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。

当前仓库包含空的 `.nojekyll` 文件，并随根目录静态文件发布；它用于明确按静态文件处理，但不能替代 Pages 发布源设置。若未来改成 Jekyll、`gh-pages` 或自定义 Actions，必须重新记录发布源和验证结果。

### 2.2 Pages 发布后核验

不要只看 GitHub commit 状态。至少核对：

- Pages 构建记录显示目标提交成功；
- `https://lvmelon.github.io/stardew-todo/` 返回目标页面；
- `index.html`、`manifest.webmanifest`、`sw.js`、JS/CSS、图片和图标都从项目子路径返回 200；
- Service Worker 的新版本已安装、下一次生命周期接管了页面、用户能看到更新提示；这三个状态分别记录；
- 桌面宽屏、窄屏/安全区和 iPhone Safari 主屏幕安装流程无明显溢出/不可点击区域。

所有前端资源使用相对路径（例如 `./sw.js`、`assets/scene.webp`），禁止写死域名根路径 `/assets/...`。

## 3. Cloudflare 准备

目标是保持免费层可运行，但 Cloudflare 计划、额度和产品限制会变化，不能把“0 元”当作永久承诺。上线前查看 [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)、D1 配额和账户当前计费状态；设置用量告警。

需要项目所有者完成或授权：

- Cloudflare 账号与 Worker 部署权限；
- Cloudflare Account ID；
- D1 数据库创建；
- VAPID key 生成和安全保存；
- GitHub 仓库 Actions Secrets；
- 生产 Worker URL 与 Pages origin 的 CORS 配置。

这些是外部授权/账号动作，不能由本地代码或普通 Git commit 推断完成。

## 4. D1 创建与迁移

在 `worker/` 目录执行目标流程（执行前确认名称和账号）：

```powershell
Set-Location worker
npx wrangler d1 create stardew-todo
```

把命令返回的 `database_id` 写入 `worker/wrangler.jsonc` 的 D1 配置。真实 ID 不是 API secret，但应避免在不相关文档、日志或截图中暴露账号细节；不要保留全零占位符作为生产配置。

应用迁移：

```powershell
npx wrangler d1 migrations apply stardew-todo --remote
```

发布前核对 migration 顺序、表和索引，尤其是：

- `spaces`、`devices`、`tasks`、`comments`、`push_subscriptions`；
- 普通提醒部分索引：`reminder_at` + `status = 'open'` + sent 条件；
- 逾期提醒部分索引：`overdue_at` + `status = 'open'` + sent 条件；
- `comments(space_id, task_id, created_at)`；
- access token hash 与空间/设备索引。

D1 文档：[Cloudflare D1](https://developers.cloudflare.com/d1/)。迁移不是完整本地任务备份，不能删除现有 IndexedDB 数据来“对齐” D1。

## 5. Worker 变量与 Secrets

### 5.1 非敏感变量

`worker/wrangler.jsonc` 目标包含：

- `APP_VERSION`；
- `ALLOWED_ORIGINS`：生产 Pages origin 与明确的本地开发 origin，逗号分隔；
- D1 binding `DB`；
- Cron `* * * * *`。

生产 CORS 必须是 exact origin，不使用 `*`。本地开发 origin 不应被误配置到公开生产实例。

### 5.2 VAPID Secrets

在 Worker 环境通过 Wrangler 写入，不提交原文：

```powershell
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

`VAPID_PRIVATE_KEY` 只在 Worker 发送 Push 时使用；public key 可由 `/v1/config` 返回，但当前实现若以 secret 方式读取，仍不得把它写入 Git。Secret 管理官方说明：[Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

根目录 `.env.example` 和 `worker/.env.example` 只能保留变量名、空值和说明；不要创建或提交 `.env`、`.dev.vars`、真实备份或 Wrangler 本地状态。

## 6. Worker 部署

本地检查与 dry run：

```powershell
Set-Location worker
npm ci
npm run check
npm test
npm run deploy:dry-run
```

实际发布在确认 D1、Secrets、origin 和 migration 后执行：

```powershell
npm run deploy
```

部署后检查：

```powershell
Invoke-WebRequest -UseBasicParsing https://<worker-domain>/health
Invoke-WebRequest -UseBasicParsing https://<worker-domain>/v1/config
```

`/health` 不得返回 secret、SQL 或 token；`/v1/config` 只返回非敏感前端配置。再用一台 owner 设备和一台 partner 设备实际验证创建空间、配对、镜像读写权限、留言、Push 订阅和断开设备。没有这些请求/响应证据时，状态记录为未验证。

## 7. Cron 与 Web Push 验收

Cron 的目标频率是每分钟；Worker 扫描带索引的到期候选，不允许每分钟全表扫描。验收至少包含：

- open + 到提醒时间 + 未发送：触发一次；
- completed/deleted：不触发；
- open + 已逾期 + 未发送：逾期提醒最多一次；
- Cron 重入/请求超时：claim/sent 条件不会造成无界重复；
- 无效 Push endpoint：记录受控错误并继续处理批次；
- 用户拒绝或撤销通知权限：本地 Todo 仍可用，设置页状态可理解。

iPhone 需先把 Pages HTTPS 网站添加到主屏幕，再在用户点击后申请通知。WebKit 对 iOS/iPadOS 16.4+ 主屏幕 Web App Web Push 的说明见 [Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。PC、Safari、iPhone 前台/后台/关闭状态分开记录，不能把桌面测试结果当成 iPhone 真机结论。

## 8. GitHub Actions 自动部署 Worker

仓库当前已包含 `.github/workflows/ci.yml` 和 `.github/workflows/deploy-worker.yml`。文件存在不等于 workflow 已成功运行；首次启用仍需由项目所有者配置 Secrets，并在 GitHub Actions 页面查看 run 结果。

`deploy-worker.yml` 的当前触发条件是：

- push 到 `main` 且 `worker/**` 或该 workflow 改动；
- 当前文件没有把 Pull Request 部署到生产，PR 由 `ci.yml` 做检查/测试。

Actions job 至少执行：

1. checkout；
2. Node 版本固定并 `npm ci`；
3. 前端检查/测试与 Worker `npm run check && npm test`；
4. 仅在 main 发布 job 执行远程 D1 migration/deploy（Wrangler migration 应保持幂等；破坏性 migration 禁止直接进入该 job）；
5. 调用 Worker health check；
6. 输出版本、migration 和 health 结果，不输出 token 或任务内容。

仓库 `Settings` → `Secrets and variables` → `Actions` 中配置最小权限：

- `CLOUDFLARE_API_TOKEN`：仅允许目标 Worker/D1 所需权限；
- `CLOUDFLARE_ACCOUNT_ID`：账户标识；
- 若工作流需要迁移或 VAPID 操作，使用专门的 secret，不把值写入 YAML。

官方 CI 参考：[Cloudflare Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)、[GitHub Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)。

当前 workflow 会先执行远程 D1 migration，再用 Wrangler Action 部署 Worker。“工作流文件已写入”不等于“Actions 成功运行”；必须查看 run 日志、Worker deployment、D1 migration 和 `/health` 响应。

## 9. 发布顺序

推荐顺序：

1. 在功能分支完成前端、Worker、migration、测试和文档；
2. 本地运行 `npm run verify`、`npm --prefix worker check`、`npm --prefix worker test` 和浏览器验收；
3. 由项目所有者确认 Cloudflare 账户、D1、VAPID 和 Actions Secrets；
4. 先在非生产/临时 Worker 验证 health、配对、镜像、留言、权限和 Push；
5. 合并到 `main`；
6. Pages 重新发布静态前端；
7. Actions 部署 Worker（若已配置）；
8. 分别核验 Pages 构建、Worker deployment、D1 migration、Cron 和设备通知；
9. 在发布记录中标注每一项“已验证/未验证/阻塞原因”。

## 10. 回滚与故障处理

- 前端：回滚一个已知可用的 Git commit，等待 Pages 构建，再核验 Service Worker 缓存/控制状态；不要用删除网站数据作为默认修复。
- Worker：使用 Cloudflare deployment 版本回退或重新部署上一个已验证版本，保留 D1 数据；不要 `DROP TABLE` 或用破坏性迁移“回滚”。
- migration：优先编写前向兼容迁移，必要时增加新 migration 修复；正式环境执行前备份/确认影响范围。
- Push：先撤销受影响 VAPID/订阅，再保持本地 Todo 可用；通知失败不应阻塞任务 CRUD。
- token 泄露：立即轮换/撤销，检查日志和 Actions，通知受影响用户；不要把泄露值复制到 issue 或报告。

## 11. 成本与运维记录

Cloudflare 免费层是否足够取决于实际 Worker 请求、D1 读写、Cron 频率和 Push 使用量。每分钟 Cron 是产品目标，但应监控 D1 行数、索引命中、Worker CPU/请求和错误率；超过免费配额前暂停非必要扫描或优化批量。任何“免费运行”结论都必须注明核验日期和当前计划，而不是永久保证。

每次发布记录：

- Git commit；
- Pages build URL/状态；
- Worker deployment/version；
- migration 版本；
- Cron 是否执行；
- health/config HTTP 结果；
- PC/iPhone Push 测试条件和结果；
- 未验证项、授权阻塞和回滚点。
