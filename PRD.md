# 今日任务 · 像素田园待办 V1.0 产品需求文档

| 项目 | 内容 |
| --- | --- |
| 产品 | 今日任务 · 像素田园待办 |
| 目标版本 | V1.0 |
| 产品形态 | Vanilla JavaScript 静态 PWA + 可选 Cloudflare Worker/D1 |
| 目标用户 | 一对希望轻松互相看见日常小事的人 |
| 线上前端 | <https://lvmelon.github.io/stardew-todo/> |
| 文档状态 | V1.0 目标与验收基线；实现、部署和真机能力须以实际证据更新 |

这份文档收口 V1.0 的产品边界。它不把“共享任务镜像”包装成完整多设备 Todo 同步，也不把 Cloudflare、Web Push 或 iPhone 真机能力写成尚未验证的既成事实。

## 1. 产品目标

让两个人每天打开应用时，像查看小镇公告板上的委托一样，低压力地知道“今天要做什么”，并能让另一方看到任务、留下一句小纸条。

核心体验：

- 治愈、简单、漂亮、低压力；
- 像素田园与木质公告板气质；
- 任务操作少于传统项目管理工具；
- 共享是陪伴和提醒，不是监督、打分或社交系统；
- 没有网络时，本机 Todo 仍然可用。

## 2. 事实、目标与验收状态

当前仓库的 V0.5 基线已经包含静态 PWA、任务 CRUD、软状态、本地持久化、Service Worker、Manifest 和 GitHub Pages 项目子路径兼容。V1.0 新增能力必须分别通过：

1. 静态检查与单元/集成测试；
2. 浏览器 DOM、IndexedDB、Worker 响应和 D1 结果核验；
3. 对 Web Push、iPhone 主屏幕、关闭应用后的通知等平台行为进行真实环境测试。

在三类证据具备前，文档中的“必须”表示产品目标，不表示已经上线。Cloudflare 控制台登录、D1 创建、Secrets 注入、Cron 运行和 iPhone 真机测试都不能仅凭本地代码推断。

## 3. V1.0 范围

### 必须交付

- 真正的今日、逾期、未来和无日期任务语义；
- 截止日期轻量提示与稳定排序；
- 本地 IndexedDB 任务主数据和旧数据迁移；
- 共享空间、配对链接、恢复码和 owner/partner 权限；
- Cloudflare Worker + D1 共享任务镜像；
- 任务留言（append-only）；
- 任务拥有者的 Web Push 提醒与一次性逾期提醒；
- 设置页：通知、同步、天气、显示、声音、数据；
- JSON 导入/导出、本地备份/恢复和清除本设备；
- PWA 新版本提示；
- 时间、季节、天气的轻量氛围、天气显示、完成动画和极轻植物成长；
- 不依赖受版权保护素材的原创 procedural BGM；
- 正式测试、CI、Cloudflare Worker 自动部署流程和完整技术文档。

### 明确不做

- 完整多设备 Todo 云同步；
- 另一方直接编辑对方的标题、描述、截止日期、提醒或完成状态；
- outbox 分布式同步队列、LWW 冲突解决、版本合并和复杂同步状态；
- 把 D1 当作所有本地任务与设置的云端主数据库；
- 全量设置、天气、BGM、动画等纯本地数据云同步；
- 用户名、密码、手机号、验证码或传统账号体系；
- 聊天 App、消息中心、积分、连续打卡、奖励商城、农场经营系统。

## 4. 数据权威与术语

这是 V1.0 最重要的边界：

| 数据 | 主来源 | 云端是否保存 | 谁能写 | 用途 |
| --- | --- | --- | --- | --- |
| 本机任务 | 当前设备 IndexedDB | 只发送必要字段 | 任务拥有者本机 | 正常 Todo 编辑和离线使用 |
| 共享任务镜像 | 任务拥有者本机写入后推送 | D1 最小字段 | Worker 只接受与任务 `ownerRole` 相同的设备角色写入 | 另一方查看、留言上下文、提醒 |
| 留言 | Worker append-only | D1 | 两个成员 | 针对具体任务留小纸条 |
| 本地显示/声音/天气设置 | 当前设备 | 否 | 当前设备 | 个性化体验 |
| 配对/设备凭据 | 当前设备 + Worker hash | 只存 hash/必要授权摘要 | 配对流程 | 进入同一空间 |

“共享镜像”不是双向同步：另一方获取的是服务器上的只读视图；另一方的留言单独写入留言表，不会反向修改本机任务。

## 5. 任务语义

### 5.1 状态与软删除

任务状态固定为：

- `open`：开放任务；
- `completed`：已完成，保留历史；
- `deleted`：已删除，保留 tombstone，避免共享镜像或历史留言被静默复活。

完成或删除先写本地，再尝试更新共享镜像。首页只显示 `open` 任务；任务详情和全部任务可以查看已完成记录及其留言，删除记录默认不出现在普通列表。

### 5.2 截止日期分类

对 `open` 任务，以使用者当前设备的本地日历日期比较 `dueDate`（`YYYY-MM-DD`）：

| 条件 | 分类 | 首页 |
| --- | --- | --- |
| `dueDate < 今天` | 逾期 | 显示 |
| `dueDate == 今天` | 今日到期 | 显示 |
| `dueDate > 今天` | 未来 | 首页不显示，全部任务可见 |
| 空值/null | 随时 | 显示 |

首页顺序：逾期（最早日期优先）→ 今日到期（创建时间稳定升序）→ 无日期（创建时间稳定升序）。未来任务在“全部任务/我们的委托”中按日期升序查看。完成任务自动从首页消失。

轻量文案：

- 今天：`今天到期`；
- 明天：`明天到期`；
- 未来：`8月30日到期`；
- 逾期：`已经等了一会儿` 或 `逾期 2 天`。

逾期使用低饱和棕杏色、纸张边缘或小图标表达，不使用刺眼的大红色警报，不显示倒计时压力。

### 5.3 创建、编辑与详情

本机任务编辑器至少包含：emoji、标题、描述、截止日期、提醒选项。标题必须非空，长度上限沿用现有验证（40 个字符）；描述保持轻量（当前 UI 上限 120 个字符可作为 V1.0 默认）。

提醒选项：

- 不提醒；
- 使用默认提醒时间；
- 自定义提醒时间。

编辑、完成、删除先写 IndexedDB；UI 立即反映结果。Worker 请求失败不得回滚本机操作。

## 6. 情侣空间与权限

### 6.1 无账号配对

创建空间时，Worker 使用 Web Crypto 的 `crypto.getRandomValues()` 生成高熵 secret；该 API 的密码学语义见 [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)。应用提供：

- 配对链接：`https://lvmelon.github.io/stardew-todo/#pair=<token>`，secret 位于 URL fragment，不进入 HTTP 请求；
- 恢复码：由同一强随机凭据或独立强随机恢复凭据编码，必须保持足够熵，不得用真正的 6 位数字作为安全凭证。

新设备打开链接后，前端读取 fragment、保存本地凭据并用 `history.replaceState` 清理地址栏。Worker/D1 只保存 SHA-256 hash 或等价不可逆摘要，不能保存原始配对 secret。所有 API 使用 HTTPS `Authorization: Bearer <device access token>`。

为了区分权限，Worker 在首次创建/加入时签发设备级 access token：

- 创建设备是 `owner`；
- 配对链接默认加入为 `partner`；
- 恢复流程显式恢复 owner 设备；
- 角色和称呼（例如“我”“她”）与设备绑定，留言显示角色/称呼。

配对链接、恢复码和 access token 都是 bearer capability：拿到的人可以尝试进入空间。它们不能出现在 console、分析事件、URL query、错误上报或提交到 Git 的文件中。

### 6.2 权限矩阵

`owner` / `partner` 是空间里的两个成员角色，不表示只有 `owner` 才能拥有本地任务。两个人都可以在各自设备创建自己的本地任务并发布镜像；两个人看到对方镜像时都只读。

| 操作 | 自己的本地任务 | 对方的共享镜像 |
| --- | --- | --- |
| 创建/编辑/完成/删除 | ✓（先写本机） | × |
| 查看任务详情 | ✓ | ✓ |
| 查看历史留言 | ✓ | ✓ |
| 新增留言 | ✓ | ✓ |
| 设置提醒并注册自己的 Push 订阅 | ✓ | × |
| 断开当前设备 | ✓ | ✓ |

Worker 从设备 token 推导角色：新镜像的 `ownerRole` 由服务端写入；已有镜像只允许同角色设备更新。客户端传入的 `ownerRole` 不构成授权。另一方得到的是 D1 只读视图，不是可编辑的本地任务副本。

## 7. 共享任务镜像

### 7.1 镜像字段

D1 只保存实现共享、留言和提醒所需字段：

`spaceId`、`taskId`、`title`、`description`、`emoji`、`dueDate`、`status`、`createdAt`、`updatedAt`、`ownerRole`、`reminderMode`、`reminderAt`、`overdueAt`、提醒 claim/sent 标记。

不上传本地 UI 设置、天气开关、定位、BGM、音量、动画偏好或其他纯本地数据。Worker 可使用服务器时间记录镜像更新时间；本地 `updatedAt` 不能被当作跨设备冲突时钟。

### 7.2 分享流程

```text
本机创建/编辑/完成/删除
        ↓
IndexedDB 先写入，UI 立即更新
        ↓
后台 POST/PUT 共享任务镜像
        ↓ 成功
清除 pendingShareSync，记录最后分享时间
        ↓ 失败
保留本地任务 + 标记 pendingShareSync
        ↓
应用打开 / 网络恢复 / 手动刷新时轻量重试
```

这里不实现完整 outbox、双向拉取、LWW 或多设备合并。首次启用共享时必须明确询问“将这台设备已有任务同步到我们的空间吗？”。默认不静默上传、不静默覆盖：任务 ID 使用高熵随机值，V0.5 的固定示例 ID 在首次连接空间时先在本机安全改名；若 Worker 仍拒绝写入，保留本地任务和待分享标记，由用户手动重试，不覆盖另一角色的既有镜像。新空间只在确认后批量创建镜像。

若 Worker 不可用，本机仍能创建、编辑、完成和删除任务。伙伴在 Worker 不可用时只能看到上次成功取得的共享视图（若本机有缓存）；不能把离线镜像当作实时状态。

## 8. 任务留言

留言是轻量小纸条，不是聊天系统。每条留言必须绑定 `spaceId` 与 `taskId`，至少包含：

`commentId`、`taskId`、`spaceId`、`authorRole`、`content`、`createdAt`。

双方都可以查看、新增留言；V1.0 不提供编辑、删除、回复线程或已读回执。内容长度限制、节流和文本转义由 Worker 与前端共同执行。完成任务后任务和历史留言仍可查看；软删除任务的留言保留，但普通首页不显示该任务。

示例：

```text
💌 留言
她：下班记得去拿哦
我：收到～
```

## 9. 提醒与 Web Push

### 9.1 前置条件

通知权限只在用户点击“开启通知”或“测试通知”后申请。Web Push 需要 Service Worker、Push API、Notifications API 和 HTTPS；iPhone/iPad 还需要将网站添加到主屏幕，WebKit 官方说明见 [Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。文档目标兼容 iOS/iPadOS 16.4+，但必须以真实设备测试结果为准。

PC 浏览器、Safari 和 iPhone 的前台、后台、关闭 App 状态分别验证。浏览器支持检测失败时，设置页给出温和说明，不把本地 `setTimeout`/`setInterval` 当作可靠的关闭 App 提醒。

### 9.2 提醒模型

任务拥有者设置：

- `none`：不提醒；
- `default`：使用设置页的默认提醒时间；
- `custom`：使用该任务的 `reminderAt`。

D1 保存 owner 提醒所需最小字段。Worker Cron 每分钟扫描有索引的候选记录：

- `reminder_at <= now`、`status = 'open'`、`reminder_sent_at IS NULL`，且尚未进入逾期提醒时间：普通提醒；
- `overdue_at <= now`、`status = 'open'`、`overdue_reminder_sent_at IS NULL`：逾期提醒；`overdueAt` 由任务拥有者设备按本地日历换算成 UTC 绝对时间。

每条任务的普通提醒和逾期提醒最多各触发一次；完成后不再触发。如果 Cron 中断到任务已经进入逾期提醒时间，逾期文案优先，不再补发同一分钟的普通提醒，避免连续通知。数据库更新要有原子 claim/状态条件以避免 Worker 重入造成重复尝试。外部 Push 服务的重复投递、网络超时或设备系统策略无法由应用完全控制，验收中应区分“Worker 已成功提交一次”和“设备最终展示一次”。

通知文案保持自然：

- `提醒：记得完成「取快递」`；
- `「取快递」还没有完成`。

不使用高压倒计时、惩罚或过度游戏化文案。

## 10. 设置页

设置入口沿用当前木质、羊皮纸和像素田园语言，不改变主场景公告板的视觉锚点。

### 通知

- 当前浏览器通知状态；
- 用户手势触发的开启通知；
- 默认提醒开关；
- 默认提醒时间（例如 20:00）；
- 测试通知；
- 不支持、拒绝或被系统撤销时的可理解说明。

### 同步/共享

- 当前空间与角色；
- 当前共享镜像状态（在线、待分享、暂不可用）；
- 最后成功分享时间；
- 配对新设备；
- 显示恢复码（再次确认后）；
- 手动立即分享/刷新；
- 断开当前设备。

这里的“同步状态”只表示共享镜像请求状态，不表示完整多设备同步进度。

### 天气

- 天气开关；
- 浏览器明确授权后的自动定位；
- 手动位置；
- 手动刷新；
- 天气服务不可用时安静降级，不阻塞 Todo。

定位和天气设置只保存在本机。天气服务的供应商、配额和隐私条款必须在实现时单独核验。

### 显示、声音和轻量成长

- 时间氛围变化；
- 季节氛围变化；
- 天气效果开关；
- 完成动画开关；
- BGM 开关与音量；
- 极轻植物成长（不引入积分、排行榜或每日压力）。

BGM 必须使用 Web Audio API 生成的原创 procedural 片段，用户第一次点击播放后才启动；不得引入未授权的游戏音乐、音效或字体素材。

### 数据

- 导出 JSON：任务、软状态、必要本地设置，以及可选的共享镜像/留言缓存；不导出空间凭据、原始 secret 或 access token；
- 导入 JSON：校验 schema 版本、预览数量、明确确认后写入本机；
- 本地备份/恢复：可下载文件或浏览器保存的本地快照；
- 清除本设备数据：明确二次确认，清除本机任务、共享缓存、备份与设置，但保留空间连接；撤销设备凭据由单独的“断开本设备”完成，两者都不删除空间或另一台设备数据。

导入/恢复默认只影响本机，不静默上传共享镜像；若用户确认把恢复后的任务重新分享，必须再次明确确认。

## 11. 迁移与兼容

V0.5 任务必须保留：`id`、`title`、`description`、`emoji`、旧 `dueDate`、`status`、`createdAt`、`updatedAt`、`completedAt`/`deletedAt`（若存在）。

新增字段使用安全默认值：

- `ownerRole`：当前设备角色或 `owner`；
- `reminderMode`：`none`；
- `reminderAt`、`reminderSentAt`、`overdueReminderSentAt`：`null`；
- `pendingShareSync`：未启用共享时为 `false`；
- 评论数组/共享缓存：空，不覆盖本地任务。

迁移路径必须覆盖 IndexedDB 版本升级和既有 `localStorage` fallback（当前 key 为 `stardew_todo_tasks_v05`）。第一次启用共享时要先读取现有本地任务，再展示明确确认；不得因初始化 Worker 或 D1 而清空或静默替换本地任务。

恢复码可以恢复空间访问和共享镜像视图，但不能被宣传成完整的本地任务/设置云备份。要可靠迁移本地主数据，使用 JSON 导出/导入或本地备份。

## 12. PWA 更新

更新体验必须区分三个状态：

1. 新 Service Worker 已安装；
2. 当前页面已由新版本控制；
3. 用户已看到并确认更新提示。

新版本提示不应打断正在编辑的表单或留言；用户确认后才激活并刷新。GitHub Pages 子路径、旧缓存清理、离线应用壳和 Worker API 地址都要在发布后核验。

## 13. 验收标准

### 产品行为

- [ ] 首页只显示逾期、今日到期、无日期的开放任务，未来任务在全部任务中可见。
- [ ] 逾期排序和今日/无日期稳定排序可由固定测试数据复现。
- [ ] 完成/删除先写本地，任务从首页消失，历史状态不物理删除。
- [ ] Worker 故障、断网或恢复网络时本机 Todo 仍可用，待分享记录能轻量重试。
- [ ] 第一次开启共享有确认；每个角色只能发布/更新自己的镜像，查看对方镜像时只能查看和留言。
- [ ] 双方留言绑定正确任务，追加顺序稳定，任务完成后仍可查看。
- [ ] URL fragment 配对成功后地址栏清理；secret 不出现在 query、日志、分析或 Git。
- [ ] 通知权限只由用户手势触发；普通/逾期提醒完成后不再发送。
- [ ] JSON 导入导出和本地备份恢复不破坏旧任务，导入不会静默上传。

### 工程与发布

- [ ] IndexedDB、localStorage fallback、迁移和刷新结果有自动化覆盖。
- [ ] Worker route、鉴权、owner/partner 权限、D1 migration、索引查询、Cron claim 和 Web Push payload 有测试。
- [ ] `node --check`/lint、单元测试、`git diff --check` 和浏览器实际验证通过。
- [ ] Pages、Worker、D1、Cron 和 VAPID Secrets 的状态分别记录；没有证据的项目标为未验证。
- [ ] 桌面和窄屏截图检查公告板、弹窗、设置、留言、通知状态和安全区。

## 14. 官方资料

- [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [WebKit: Meet Web Push](https://webkit.org/blog/12945/meet-web-push/)
- [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)
- [W3C Push API](https://www.w3.org/TR/push-api/)
- [WHATWG Notifications API](https://notifications.spec.whatwg.org/)
- [Cloudflare D1 documentation](https://developers.cloudflare.com/d1/)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [GitHub Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
