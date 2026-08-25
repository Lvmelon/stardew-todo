# 今日任务 · 像素田园待办 V1.0 安全与隐私说明

这是一份 V1.0 的安全基线与实施约束，不是渗透测试报告或隐私合规认证。截至 2026-08-25，Worker、D1、VAPID Secrets、Cron trigger、角色权限、留言和 CORS 已通过部署或线上响应核验；外部 Push 服务接受和 iPhone/PC 最终展示仍须真实订阅与设备测试。

## 1. 安全边界

系统分成两个信任域：

1. **本机域**：IndexedDB、localStorage fallback、浏览器权限、本地设置、导出文件和 BGM/天气数据。设备上的站点数据被清除后，应用无法保证恢复本地主数据。
2. **共享域**：Cloudflare Worker、D1 shared task mirror、成员设备 token、留言和任务拥有者设备的 Push 订阅。共享域的 bearer 凭据能访问情侣空间，拿到配对链接/恢复码的人必须视为获得访问能力。

产品不提供账号、密码、验证码或身份认证。因此“知道共享凭据”就是 V1.0 的主要授权因素；不能把它描述成企业级账户安全或强身份核验。

## 2. 数据最小化

D1 只保存：

- space/member 授权摘要和 hash；
- 任务共享镜像必要字段：`taskId`、`spaceId`、标题、描述、emoji、开始日期、截止日期、状态、创建/更新时间、ownerRole；
- 提醒所需的 `reminderMode`、`reminderAt`、发送标记；
- append-only 留言；
- 两个角色各自设备的 Web Push subscription 必要字段；提醒只投递给与任务 `ownerRole` 相同的设备角色。

不上传：

- 天气开关、自动定位、手动位置、天气缓存；
- 时间/季节/天气动画、场景小动画、完成动画、BGM、音量；
- 其他纯本地 UI 设置；
- 本地 fallback 整体数据库或未被用户选择分享的任务。

任务全文和留言属于两个人的私密生活数据。不要在分析事件、错误上报、URL、性能日志或调试输出中记录它们，除非经过明确脱敏且确有诊断必要。

## 3. 配对与凭据

### 3.1 生成与存储

- 创建空间使用 `crypto.getRandomValues()` 生成高熵 pairing/recovery secret；参考 [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)。
- 配对链接使用 URL fragment（`#pair=...`），不使用 query；fragment 在正常 HTTP 请求中不会发送给服务器。
- 新设备读取 fragment 后立即保存必要本地凭据，并使用 `history.replaceState` 清理地址栏、浏览器历史可见内容和复制风险。
- Worker/D1 只保存 secret 的 SHA-256 hash（或等价的单向摘要），不保存原文。高熵 secret 可直接 hash；不要把低熵 6 位数字当作真正授权凭据。
- Worker 返回原始 pairing token、recovery code 和首次 access token 一次；页面不打印、不埋点、不发送到非 Worker 域名。
- `.env.example` 只有变量名和空值；真实值通过 `wrangler secret`、本地未提交 `.dev.vars` 或 GitHub Actions Secrets 注入。

Web Crypto 的 SHA-256 digest 规范见 [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)。实际实现需要验证编码、大小写、base64url 规范化和 hash 比较路径一致。

### 3.2 设备 token 与角色

Worker 将配对/恢复能力交换为设备级 access token，D1 只保存 `access_token_hash`：

- 首次创建设备角色为 `owner`；
- 普通配对默认角色为 `partner`；
- 恢复流程显式恢复 owner 设备；
- 两个角色都可发布自己的镜像；任何任务写入路由都必须在 Worker 检查已有任务的 `owner_role` 与当前设备角色一致；
- owner/partner 的昵称只用于留言显示，不能成为授权凭据。

浏览器前端隐藏编辑按钮不构成安全边界。每个受保护 API 都必须解析 Bearer token、验证 hash、检查 space 归属、检查角色和请求资源。

### 3.3 凭据暴露与撤销

高风险位置：屏幕截图、剪贴板、浏览器同步历史、录屏、误发聊天、错误日志、代理访问日志和导出文件。设置页显示恢复码前需要明确用户操作；复制后提供短暂提示，不写入 analytics。

V1.0 至少提供：

- 断开当前设备：撤销该设备 token 和 Push subscription；
- 重新生成空间配对能力：废弃旧 pairing/recovery hash，并提醒另一方重新配对；
- 删除空间的运维流程（如实现）：先确认影响，避免把本地任务误删。

如果无法安全撤销某类历史 token，应在 UI 明确说明“持有旧凭据者仍可能访问”，不要宣称已彻底失效。

## 4. 网络与 Worker 防护

- 生产 API 只接受 HTTPS；前端必须使用配置的 Worker origin，不能把 secret 放在静态 JS。
- CORS 只允许 `ALLOWED_ORIGINS` 中的精确 origin（生产 GitHub Pages origin + 明确开发 origin），拒绝 `*`；Origin 校验不是认证，Bearer 仍必须存在。
- 所有请求限制 body 大小、标题/描述/留言长度和日期格式；Worker 只从字段白名单构造 D1 写入，未知字段不会进入镜像，从而避免把本地设置意外写入服务器。
- 任务写入接受有效设备 token，但新镜像的 `owner_role` 必须由 Worker 从 token 角色写入；更新另一角色拥有的镜像返回 403，且不能因为前端传入 `ownerRole` 就越权。
- `spaceId`、`taskId`、`commentId` 和 subscription ID 都要做格式/归属校验；不能通过可猜 ID 访问另一空间。
- 留言使用 append-only；V1.0 不允许编辑/删除，降低冲突与审计复杂度。当前实现有长度和请求体上限；若该私有空间暴露给更多用户，部署前还需增加 Cloudflare 侧速率限制。
- D1 使用参数化 SQL/绑定参数，不拼接用户输入；删除任务写 tombstone，不用物理删除绕过历史或留言约束。
- 响应头按最小权限设置；至少考虑 `Content-Security-Policy`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff` 和合理的 `Cache-Control`。Bearer API 响应禁止公共缓存。
- `/health` 与 `/v1/config` 可公开，但不返回数据库错误详情、secret、token、Push 私钥、内部 SQL 或空间内容。

## 5. Web Push 安全

Web Push 依赖 HTTPS、Service Worker、Push API 和 Notifications API；iPhone/iPad 还需要主屏幕 Web App 和对应 WebKit 支持，依据见 [WebKit iOS/iPadOS Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。

- 通知权限只在用户点击“开启通知/测试通知”后申请，不在首次打开页面请求。
- VAPID public key 可以发给前端；VAPID private key、subject 配置只能存 Worker secret/CI secret，绝不提交 Git。
- D1 只存订阅 endpoint、p256dh、auth、设备和过期时间等必要字段；订阅属于敏感设备标识，不写日志、不对 partner 返回。
- Push payload 只包含自然、必要的提醒文案和任务 ID；避免把完整描述、空间 secret 或其他任务列表放进 payload。
- Service Worker `push` 处理必须确保一次事件只展示一次通知；点击通知后打开项目子路径中的任务详情，不拼接未转义用户文本到 HTML。
- 任务完成或删除后，Cron 条件必须排除 `status != 'open'`；普通/逾期提醒分别用 sent 标记和原子条件避免 Worker 重入。
- 网络超时可能导致“已提交但客户端未知”的边界。实现应记录一次 claim/attempt，测试报告必须区分“Worker 尝试一次”“Push 服务接受”“设备显示一次”，不能承诺系统层绝不重复。
- 权限被用户拒绝、撤销、系统 Focus/省电模式或浏览器不支持时，设置页显示状态并保持本地 Todo 可用。

参考标准：[W3C Push API](https://www.w3.org/TR/push-api/)、[WHATWG Notifications API](https://notifications.spec.whatwg.org/)。

## 6. 本地数据与备份风险

- IndexedDB 是 Todo 主数据，不是经过加密的保险箱；共享设备、恶意扩展、浏览器调试权限或操作系统账户失陷都超出本应用边界。
- localStorage fallback 的数据也不能当作安全存储；在 IndexedDB 不可用时，设备 access token 可能随共享凭据降级保存在该站点的 localStorage，UI 必须说明清除站点数据会丢失访问能力。VAPID private key 永远不能进入浏览器存储。
- JSON 导出是明文文件。导出前提示用户存放位置，导入前显示任务数量/版本，导入后不自动上传共享镜像。
- 导出默认排除原始 pairing/recovery secret、device access token、Push 私钥和调试日志；若用户明确选择导出空间恢复材料，必须单独二次确认，并在文档中标为高风险。
- “恢复码恢复空间”只能恢复共享空间访问/共享镜像视图，不等于恢复原设备的全部本地任务与设置。完整本地主数据迁移依靠用户保管 JSON 或本地备份。
- “清除本设备数据”只清本机任务、共享缓存、备份和本地设置，并明确保留空间连接；要撤销设备 token 与 Push subscription，使用单独的“断开本设备”。两种操作都不得误删 D1 空间。

## 7. 日志、分析与隐私

禁止记录：

- `Authorization` header、pair/recovery/access token 原文或 hash；
- VAPID private key；
- 完整任务标题/描述、留言内容、Push endpoint；
- URL fragment、恢复码或剪贴板内容；
- 精确定位（天气功能应只在本机或经用户同意的天气服务请求中使用）。

允许的最小运维日志：request ID、路由、HTTP 状态码、耗时、匿名错误类别、Cron 批次大小和被清理的订阅数量。错误响应给用户自然文案，服务端内部详情只进入受控日志并脱敏。

默认不接入第三方 analytics。若未来增加，必须先定义字段白名单、保留期、退出机制，并确认不会捕获 secret、任务文本、留言或位置。

## 8. 依赖与供应链

- 前端保持无大型框架、无远程 CDN 运行时依赖；Service Worker 缓存只加入审查过的本仓库资源。
- Worker 的 Web Push 依赖要固定版本，提交 lockfile，CI 运行审计和测试；升级依赖时检查许可证、打包产物和 Web Crypto 实现。
- GitHub Actions workflow 使用最小权限、固定 action 版本或 commit SHA；只向 Worker 部署 job 暴露 Cloudflare token。
- `.gitignore` 必须排除 `.env`、`.dev.vars`、Wrangler 状态、coverage、日志和本地备份；提交前运行 secret scan 或等价检查。
- `wrangler.jsonc` 中的 D1 database ID、origin 和 compatibility date 可以是配置值，但不能把 API token、VAPID private key 或真实 secret 放进去。

## 9. 威胁模型与缓解

| 威胁 | 影响 | V1.0 缓解 |
| --- | --- | --- |
| 配对链接被转发 | 进入空间、读取镜像/留言 | 高熵 secret、fragment、明确提示 bearer 风险、撤销/重配对 |
| 任一成员伪造另一角色请求 | 修改/完成/删除对方镜像、冒用提醒 | Worker 设备 token hash + 服务端 `owner_role` 检查 |
| URL/日志泄露 token | 持续访问 | 不用 query、立即清理 fragment、禁止日志/分析、HTTPS |
| D1 注入或越权 ID | 读取/修改他人空间 | 参数绑定、space/resource ownership 校验、CORS 不替代鉴权 |
| 评论 XSS | 运行恶意脚本 | 长度/字符校验、JSON、前端 `textContent`、CSP |
| Push 私钥泄露 | 冒发通知 | 仅 Worker secret/CI secret、最小 CI 权限、轮换 |
| Cron 重入/网络重试 | 重复提醒 | 索引候选 + 原子 claim/sent 标记、批次上限 |
| D1/Worker 不可用 | partner 看不到新镜像 | 本地任务不依赖云、`pendingShareSync` 轻量重试、UI 显示状态 |
| 导出文件外泄 | 本地任务泄露 | 明文风险提示、默认不导出凭据、用户自行保管 |
| 设备丢失 | 本地任务/凭据暴露 | 系统锁屏、断开设备、重配对；应用不能替代 OS 设备安全 |

## 10. 上线前安全验收

- [ ] 搜索 Git 历史、构建产物、日志和导出文件，没有真实 secret、token 或 VAPID private key。
- [ ] 创建空间只返回一次原始配对/恢复材料；D1 只看到 hash。
- [ ] URL fragment 配对成功后地址栏、History、console 和网络 query 中无 token。
- [ ] 两个角色能发布自己的镜像和注册自己的 Push；跨角色任务更新、跨设备 subscription 删除及越权 space/task ID 均被服务端拒绝。
- [ ] CORS 只允许精确 origin；`/health` 不泄露内部错误。
- [ ] 标题、描述、留言、错误和通知文案没有 HTML 注入路径。
- [ ] 普通/逾期 Cron 查询命中索引，并在重复 Cron/超时测试中不重复 claim。
- [ ] Notification 拒绝、撤销、浏览器不支持、iPhone 未安装主屏幕时仍能正常使用本地 Todo。
- [ ] JSON 导入/导出明确版本和风险，默认不包含原始凭据且不自动上传。
- [ ] Actions secret 最小权限；Worker secret 与 Pages 静态发布完全分离。

## 11. 事件处理

发现凭据、Push 私钥、D1 数据或用户内容泄露时：

1. 立即停止相关自动部署/日志采集，不在 issue、聊天或 commit 中复制秘密；
2. 撤销/轮换 VAPID key、Cloudflare API token、受影响的空间 pairing/recovery/access token；
3. 检查 Worker/D1/Actions/Pages 日志范围，保留必要证据并删除误提交的 secret；
4. 用不包含任务全文和凭据的方式通知受影响用户，说明已知范围与下一步；
5. 修复后运行完整安全回归，再恢复部署；
6. 记录事实、推测和未知项，不能把“未发现证据”写成“没有泄露”。

## 12. 参考资料

- [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)
- [W3C Push API](https://www.w3.org/TR/push-api/)
- [WHATWG Notifications API](https://notifications.spec.whatwg.org/)
- [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [GitHub Actions secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)
