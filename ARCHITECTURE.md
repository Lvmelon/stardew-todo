# 今日任务 · 像素田园待办 V1.0 架构说明

## 1. 架构结论

V1.0 是“本地任务主数据 + 云端共享任务镜像”：

- 前端仍是可直接部署到 GitHub Pages 的 HTML、CSS、Vanilla JavaScript、IndexedDB、Service Worker 和 Manifest；
- 本机 IndexedDB 负责 Todo 的真实编辑、离线使用和软状态历史；
- Cloudflare Worker + D1 只接收必要任务字段，形成给另一方查看、留言和提醒使用的共享镜像；
- 两个成员都只在各自本机编辑自己的任务；Worker 只允许设备角色创建/更新同角色拥有的镜像；
- 留言单独采用 append-only 表，双方都可以追加；
- Worker Cron 只扫描带索引的到期候选，不把 Worker 变成本地任务的完整云端主库。

这不是完整多设备同步系统：没有双向任务拉取、outbox 分布式队列、LWW 冲突合并、伙伴编辑对方任务或全量设置云同步。

> 文档描述的是 V1.0 目标架构。Cloudflare 登录、D1、Secrets、Cron、Web Push 和 iPhone 真机行为必须由发布验收单独证明；本文件不声称它们已经部署或真机验证。

## 2. 用户指定的数据流

```text
她的 iPhone
    ↓
IndexedDB（主数据）
    ↓ 必要字段
Cloudflare Worker
    ↓
D1 Shared Task Mirror
    ↓
我的手机 / PC
    ↓
查看任务 + 留言

Cron
↓
到期任务
↓
Web Push
↓
任务拥有者设备
```

具体含义：

1. 她在自己的设备创建、编辑、完成或删除任务；
2. 本地 IndexedDB 先写入，UI 立即更新；
3. 前端仅挑选共享所需字段发送 Worker；
4. Worker 将镜像写入 D1，另一个设备读取只读任务视图；
5. 另一个设备的留言写入 `comments`，不修改任务；
6. Cron 根据 D1 的提醒索引查找开放且到期的任务，向任务 owner 的 Push 订阅发送一次提醒。

## 3. 组件与职责

| 组件 | 责任 | 不负责 |
| --- | --- | --- |
| `index.html` / `styles.css` | 公告板、详情、设置、留言、状态提示和响应式视觉 | 直接持久化任务或保存 Worker secret |
| `app.js` 等前端模块 | 任务 CRUD、日期分类、IndexedDB 迁移、分享触发、Push 注册、天气/声音/更新 | 把云端当本地任务主库 |
| IndexedDB | 本机任务主数据、软删除、提醒设置、待分享标记、本地设置和可选镜像缓存 | 给 partner 提供实时数据 |
| Service Worker | 应用壳缓存、Push 事件、通知点击、版本更新协作 | 调度关闭 App 后的任务提醒 |
| Cloudflare Worker | HTTPS API、Bearer 鉴权、owner/partner 权限、D1 读写、Push 发送、健康检查、Cron handler | 取代本地任务编辑 |
| Cloudflare D1 | 共享空间、设备授权摘要、最小任务镜像、append-only 留言、Push 订阅 | 保存完整本地设置或原始 secret |
| GitHub Pages | 静态前端发布，项目子路径 `/stardew-todo/` | 发布 Worker、创建 D1 或配置 VAPID |

## 4. 本地任务模型

现有任务字段必须继续兼容：

```js
{
  id,
  title,
  description,
  emoji,
  dueDate,             // '' 或 YYYY-MM-DD
  status,              // open | completed | deleted
  createdAt,
  updatedAt,
  completedAt,
  deletedAt,
  ownerRole,
  reminderMode,        // none | default | custom
  reminderAt,
  reminderSentAt,
  overdueReminderSentAt,
  pendingShareSync     // 本地轻量标记，不是分布式 outbox
}
```

`completedAt`、`deletedAt` 或旧数据不存在时由迁移补 `null`/不显示。新增字段不能让 V0.5 的 open/completed/deleted 任务消失。

本地写入顺序固定为：

```text
用户操作
  → 校验输入
  → IndexedDB put
  → 重新渲染 UI
  → 尝试分享镜像
  → 成功清除 pendingShareSync / 失败保留标记
```

Worker 故障、断网、CORS 失败或 Push 服务错误不得回滚本地任务。应用打开、`online` 事件和设置页“立即分享”触发一次轻量重试；不引入通用 outbox、指数重放或跨设备合并器。

### 4.1 首页日期计算

日期分类由前端本地日期计算：

- `open + dueDate < today`：逾期；
- `open + dueDate === today`：今日到期；
- `open + dueDate > today`：未来；
- `open + !dueDate`：随时。

首页顺序为逾期（日期升序）→ 今日到期（创建时间稳定升序）→ 无日期（创建时间稳定升序）；未来任务在全部任务/我们的委托中查看。D1 读取视图也应提供同样的轻量分类，显示端再次按本地时区确认。

## 5. 配对、设备和权限

### 5.1 凭据生命周期

```text
创建空间
  → Worker Web Crypto 的 crypto.getRandomValues 生成 pairing secret + recovery secret
  → Worker 保存 SHA-256 hash，不保存原文
  → 返回 owner device access token、配对 token、恢复码一次

partner 打开 #pair=<token>
  → 前端读取 fragment
  → 保存凭据并 history.replaceState 清理地址栏
  → POST /v1/spaces/:spaceId/join
  → Worker 返回 partner device access token

owner 换设备
  → 明确进入恢复流程
  → 使用 recovery code 加入 owner 设备
```

配对 secret 不放 query、不打印日志、不进入分析、不写 Git。API 只接受 HTTPS `Authorization: Bearer <device access token>`；D1 只保存 `pairing_secret_hash`、`recovery_secret_hash` 和 `access_token_hash`。

设备表保存 `deviceId`、space、角色、短称呼、最后访问时间和 access token hash。access token 是设备级授权；它不是传统账号，也不意味着建立了完整多设备同步。

### 5.2 权限

Worker 在服务端强制执行：

| API 能力 | owner | partner |
| --- | --- | --- |
| 读取共享任务/详情 | ✓ | ✓ |
| 读取任务留言 | ✓ | ✓ |
| 新增任务留言 | ✓ | ✓ |
| 创建自己的镜像 | ✓ | ✓ |
| 更新同角色拥有的镜像 | ✓ | ✓ |
| 更新另一角色拥有的镜像 | × | × |
| 注册当前设备的 Push 订阅 | ✓ | ✓ |

前端隐藏按钮只是体验优化，不能作为权限边界。Worker 必须从 access token 推导角色，覆盖客户端提交的 `ownerRole`，并拒绝任何跨角色镜像更新。

## 6. D1 Shared Task Mirror

当前目标 migration 可采用以下最小逻辑模型（字段名与 `worker/migrations/0001_initial.sql` 保持一致）：

```sql
spaces (
  space_id TEXT PRIMARY KEY,
  pairing_secret_hash TEXT NOT NULL,
  recovery_secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)

devices (
  device_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  access_token_hash TEXT UNIQUE NOT NULL,
  role TEXT CHECK (role IN ('owner', 'partner')) NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
)

tasks (
  space_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  emoji TEXT NOT NULL,
  due_date TEXT,
  status TEXT CHECK (status IN ('open', 'completed', 'deleted')) NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  revision INTEGER NOT NULL,
  reminder_mode TEXT NOT NULL,
  reminder_at TEXT,
  overdue_at TEXT,
  reminder_claimed_at TEXT,
  overdue_reminder_claimed_at TEXT,
  reminder_sent_at TEXT,
  overdue_reminder_sent_at TEXT,
  PRIMARY KEY (space_id, task_id)
)

comments (
  space_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  author_role TEXT NOT NULL,
  author_label TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, comment_id)
)

push_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

必要索引：

- `tasks(space_id, status, updated_at)`：共享任务列表；
- `idx_tasks_reminder_due(reminder_at, reminder_claimed_at, space_id, task_id)`：`open` 且普通提醒未发送的部分索引；
- `idx_tasks_overdue_at(overdue_at, overdue_reminder_claimed_at, space_id, task_id)`：`open` 且逾期提醒未发送的部分索引；
- `comments(space_id, task_id, created_at)`：留言时间顺序；
- `devices(access_token_hash)` 与 Push 订阅的空间/设备索引。

`revision` 仅用于阻止同一任务的旧重试覆盖较新镜像，不实现跨设备 LWW 或自动冲突解决。双方都只能编辑各自的本地任务，查看对方镜像时没有写权限。任务删除是 `status = 'deleted'` tombstone；留言外键与历史记录按产品保留策略处理，不直接从本地物理删除。

## 7. Worker API 契约

实现可以调整响应包装，但能力和权限边界必须保持：

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/health` | 否 | 健康检查、版本/数据库绑定状态（不泄露 secret） |
| `GET` | `/v1/config` | 否 | 返回非敏感前端配置，例如 VAPID public key |
| `POST` | `/v1/spaces` | 否 | 创建空间，返回一次性的 owner access、pairing token、recovery code |
| `POST` | `/v1/spaces/:spaceId/join` | pair/recovery token | 创建 partner 或恢复 owner 设备 |
| `GET` | `/v1/spaces/:spaceId` | device token | 查看当前空间和设备角色 |
| `POST` | `/v1/spaces/:spaceId/pairing` | owner token | 轮换配对/恢复材料 |
| `DELETE` | `/v1/spaces/:spaceId/devices/me` | device token | 断开当前设备 |
| `GET` | `/v1/spaces/:spaceId/tasks` | device token | 查看共享任务镜像 |
| `GET` | `/v1/spaces/:spaceId/tasks/:taskId` | device token | 查看单条任务详情 |
| `POST`/`PUT` | `/v1/spaces/:spaceId/tasks/:taskId` | device token | 创建同角色镜像，或更新同角色已有镜像；只接受必要字段 |
| `GET` | `/v1/spaces/:spaceId/tasks/:taskId/comments` | device token | 查看留言 |
| `POST` | `/v1/spaces/:spaceId/tasks/:taskId/comments` | device token | 追加留言，不提供编辑/删除 |
| `POST` | `/v1/spaces/:spaceId/push-subscriptions` | device token | 注册/更新当前设备 Web Push 订阅 |
| `DELETE` | `/v1/spaces/:spaceId/push-subscriptions` | device token | 按当前设备和 endpoint 撤销订阅 |

所有受保护路线：

- 只接受 HTTPS；
- 使用 exact-origin CORS，不使用 `*`；
- 解析后验证 `spaceId`、角色、字段长度、日期格式、状态和 content type；
- 使用 `textContent`/JSON，禁止把标题、留言或错误直接拼成 HTML；
- 不在响应、日志或错误追踪中返回原始 secret、Bearer token 或 Push 私钥。

## 8. 留言流程

```text
设备 GET /tasks/:taskId/comments
       ↓
Worker 按 (spaceId, taskId, createdAt) 返回留言

设备 POST /tasks/:taskId/comments
       ↓
Worker 鉴权 + 长度/内容校验
       ↓
D1 INSERT append-only
       ↓
双方下次打开详情时读取
```

留言使用独立 `commentId`，不参与任务镜像更新，不需要任务冲突合并。任务完成后读取详情仍返回历史留言；删除任务保留 tombstone 和留言可见性由产品保留策略决定，默认不在首页展示。

## 9. Web Push 与 Cron

### 9.1 浏览器侧

用户在设置页点击开启通知后：

1. 检查 HTTPS、Service Worker、PushManager、Notification；
2. 调用 `Notification.requestPermission()`；
3. 使用非敏感 VAPID public key 创建 `PushSubscription`；
4. 只把 subscription endpoint、p256dh、auth 发送给当前设备的受保护 API；
5. Service Worker 处理 `push`、`notificationclick` 和前端更新消息。

iPhone 目标为添加到主屏幕且 iOS/iPadOS 16.4+；Safari/WebKit 官方依据见 [Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。桌面/移动浏览器具体表现需要单独实测。

### 9.2 Worker Cron

`worker/wrangler.jsonc` 目标 Cron 为 `* * * * *`。每分钟执行：

```text
SELECT ... FROM tasks
WHERE status = 'open'
  AND reminder_at <= server_now
  AND reminder_sent_at IS NULL
  AND (overdue_at IS NULL OR overdue_at > server_now)
ORDER BY reminder_at
LIMIT bounded_batch;
```

逾期提醒使用 `status = 'open'`、`overdue_at <= server_now`、`overdue_reminder_sent_at IS NULL` 的索引条件；`overdueAt` 已由任务拥有者设备按本地日历换算为 UTC 绝对时间。对每条候选使用带 `IS NULL` 条件的原子 claim/update，再调用 Web Push；批量大小、超时和无效订阅清理必须有上限，不能因一条坏订阅阻塞整轮。

普通提醒和逾期提醒各自只发送一次；当两者都已到期时只选逾期提醒，避免 Cron 恢复后同一分钟连续发两条。应用可以避免重复触发，但无法保证 Push 服务、浏览器或系统绝不重复投递；测试报告要区分调度端和设备端证据。

## 10. 迁移、备份与恢复

### 10.1 本地迁移

IndexedDB schema 升级保留 V0.5 store 和所有任务字段；localStorage fallback 读取现有 `stardew_todo_tasks_v05`。新增字段使用 `none`/`null`/`false` 安全默认值。迁移必须先完成本地读取，再初始化共享能力，不能因为 Worker 初始化失败而清空本地任务。

### 10.2 首次分享

首次启用共享：

1. 读取当前本地任务；
2. 显示数量和风险提示；
3. 用户确认后上传必要字段；
4. 成功记录分享状态，失败保留 `pendingShareSync`；
5. 不静默覆盖已有镜像；高熵任务 ID 与首次连接时的旧示例 ID 改名用于避免碰撞，Worker 拒绝的记录保持本地并标记待分享，等待用户手动重试。

任一角色加入空间后都不得自动上传已有本地任务；只有在用户确认后才发布本机镜像。恢复 owner 设备也不宣传为完整本地恢复；完整迁移依赖 JSON 导出/导入或本地备份。

### 10.3 JSON

导出包含 schema version、本机任务、软状态、可迁移的本地设置和用户明确选择的共享缓存；不把原始空间 secret、access token、VAPID 私钥或日志写入导出。导入先解析、验证、预览，再在确认后写入本机，默认不自动分享。

## 11. 本地设置、天气、声音和视觉

- 天气、自动定位/手动位置、时间/季节/天气效果、完成动画、BGM 开关/音量只存本机；定位不进入 D1。
- BGM 用 Web Audio API 生成的原创 procedural 音色，必须由用户点击启动，且不复用 Stardew Valley 或其他第三方音乐/音效。
- 主场景 `assets/scene.webp`、公告板位置和羊皮纸/木质语言保持为视觉锚点；新增设置、留言和权限 UI 使用同一视觉语法。
- 更新提示由页面与 Service Worker 协作：安装、控制、用户确认三个状态分别处理，不强制在编辑中刷新。

## 12. CI、部署和可观测性

- GitHub Pages：`main` + `/(root)`，只发布静态前端；资源路径必须兼容 `/stardew-todo/`。
- Worker：`worker/wrangler.jsonc` + D1 migrations；当前 `.github/workflows/deploy-worker.yml` 设计为在 `main` 更新 Worker 文件时先应用远程 migration，再部署 Worker，但 Actions 是否成功仍须现场核验。
- CI：`.github/workflows/ci.yml` 负责前端和 Worker 的 lint、语法、测试与 Wrangler dry-run；它不能替代真实 D1、Cron 或 Push 验收。
- CI secret 至少包括 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；VAPID 私钥只使用 `wrangler secret` 或 CI secret，不进 Git。
- CI 分别运行前端语法/测试、Worker node check/测试、migration dry-run 或结构校验；部署成功不等于 API、Cron 或 Push 已实际工作。
- `/health` 不返回密钥；日志只记录 request id、route、状态码、耗时和匿名错误类别，不记录 Authorization、pair/recovery token、任务全文或留言全文。

发布后的证据应分为：Pages 构建、Worker 版本、D1 migration、Cron 触发、Push provider 接受、iPhone/PC 展示。没有相应证据的状态标记为未验证。

## 13. 官方依据

- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare Worker Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers GitHub Actions CI/CD](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)
- [W3C Push API](https://www.w3.org/TR/push-api/)
- [WHATWG Notifications API](https://notifications.spec.whatwg.org/)
- [WebKit iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [GitHub Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
