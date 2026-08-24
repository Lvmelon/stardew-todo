# 今日任务 · 像素田园待办素材与致谢

这份文件记录 V1.0 使用的素材边界、技术标准和待补充的授权信息。它不把风格灵感写成官方合作，也不为仓库中尚未核实来源的二进制素材编造作者或许可证。

## 1. 项目原创与设计方向

- 产品概念、中文文案、任务语义、情侣空间和“公告板上的小委托”体验属于本项目设计范围。
- V1.0 的 BGM 由 `audio-manager.js` 使用 Web Audio API 实时合成原创短句；不引入 Stardew Valley、其他游戏或第三方歌曲、音效和采样。
- 时间、季节、天气、完成动画和极轻植物成长由前端代码表达，不使用第三方游戏的 sprite、动画或字体。
- 视觉基准是仓库现有 `assets/scene.webp`、`assets/parchment-tile.png`、`icons/` 和木质/羊皮纸 UI 语言。它们的具体制作者、来源和许可证在当前仓库中尚未逐项核实；在公开分发或重新授权前，应由项目所有者补齐证据。

## 2. 当前仓库素材清单

| 路径/内容 | 当前用途 | 来源/许可证状态 |
| --- | --- | --- |
| `assets/scene.webp` | 核心像素田园场景与公告板视觉锚点 | 现有仓库素材；作者/许可证待项目所有者确认 |
| `assets/parchment-tile.png` | 羊皮纸纹理 | 现有仓库素材；作者/许可证待项目所有者确认 |
| `icons/icon-192.png`、`icon-512.png`、`apple-touch-icon.png` | PWA 与主屏幕图标 | 现有仓库素材；作者/许可证待项目所有者确认 |
| 系统字体（如 PingFang SC、Microsoft YaHei、system-ui） | 文字显示 | 不随仓库分发字体文件；由设备系统提供 |
| `audio-manager.js` Web Audio procedural 音色 | 可选 BGM，默认关闭 | 项目代码生成的原创五声音阶短句；无外部音频、采样或游戏旋律，体验测试覆盖用户手势启动 |
| Open-Meteo Forecast / Geocoding API | 用户主动开启后的天气与位置搜索 | 远程数据服务，不把代码或素材打包进仓库；使用与配额受 [Open-Meteo Terms](https://open-meteo.com/en/terms) 约束 |
| `@mmmike/web-push` 1.3.0 | Worker Web Push 加密、VAPID 签名与发送 | MIT、零传递依赖；上游仓库：[MMMikeM/web-push](https://github.com/MMMikeM/web-push)；按 RFC 8291 `aes128gcm` 和 RFC 8292 VAPID 实现，版本以 `worker/package.json`/lockfile 为准 |

在来源确认前，不要从图片中提取 sprite、纹理或角色素材，也不要将当前素材声明为公共领域、CC0、AI 生成或项目原创。若素材来自第三方，应在此表补充原始 URL、作者、许可证、下载日期和再分发条件。

## 3. 风格与商标边界

本项目使用“像素田园/农场生活游戏”作为一般风格描述，不隶属于、也不代表 Stardew Valley、ConcernedApe、其发行方或其他游戏权利人。不得复制或重新分发 Stardew Valley 的原始 sprite、字体、音乐、音效、角色、UI 贴图或代码。README、应用界面和宣传材料避免暗示官方合作、授权或同一产品。

如果未来要展示风格参考，应链接原始官方页面而不是把第三方受版权保护素材放入仓库；任何商标使用应遵守权利人规则。

## 4. 使用的开放标准与官方资料

这些链接是实现参考，不是项目运行时下载的依赖：

- [W3C Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/)：`crypto.getRandomValues()` 与 SHA-256 digest 的标准；
- [W3C Push API](https://www.w3.org/TR/push-api/)：浏览器 Push 订阅接口；
- [WHATWG Notifications API](https://notifications.spec.whatwg.org/)：通知权限与展示接口；
- [WebKit: Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)：iOS/iPadOS 主屏幕 Web App Web Push 平台说明；
- [Cloudflare D1](https://developers.cloudflare.com/d1/)：D1 数据库文档；
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)：Worker 定时触发；
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)：敏感配置管理；
- [GitHub Pages publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)：静态站点发布源。

标准和文档链接不代表 Apple、Cloudflare、GitHub 或 W3C 对本项目背书。

## 5. 第三方代码与依赖

前端保持浏览器原生 API，不从 CDN 加载大型框架。Worker 的依赖、lockfile 和许可证应以 `worker/package.json`、`worker/package-lock.json`（如存在）为准；升级或新增依赖时必须：

- 在本文件记录包名、版本、来源和许可证；
- 运行依赖审计和测试；
- 检查打包产物没有把 VAPID 私钥、Cloudflare token 或本地凭据带入前端；
- 不把依赖作者、代码生成器或 AI 工具误写成项目素材作者。

生产运行时依赖已经按 lockfile 固定：前端无第三方运行时包，Worker 仅使用零传递依赖的 `@mmmike/web-push` 1.3.0（MIT）。测试、Lint、Wrangler 和 YAML 解析器属于开发依赖，不随 GitHub Pages 前端加载；发布流程仍应在每次升级后复查 lockfile、审计结果与 Worker bundle。

## 6. 待补充清单

- [ ] 核实 `scene.webp` 的作者、原始来源和再分发许可；
- [ ] 核实羊皮纸纹理与三个图标文件的作者、来源和许可；
- [x] 核对 Worker 生产依赖许可证与传递依赖（`@mmmike/web-push` 1.3.0，MIT，零传递依赖）；
- [ ] 记录正式发布版本、素材 hash、核验日期和变更责任人；
- [ ] 若新增天气服务、Push 库或图片服务，记录其隐私条款、许可证、配额与再分发边界。
