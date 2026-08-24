# GitHub Pages 部署

本项目是 GitHub Pages 项目站点，目标 URL 为：

`https://<GitHub 用户名>.github.io/<仓库名>/`

本仓库当前线上地址是 <https://lvmelon.github.io/stardew-todo/>。`main` 是发布分支；Pages 的实际设置和构建状态应在 GitHub 仓库页面核对，不能只根据本地 Git 推断线上已更新。

## 当前静态站点发布方式

GitHub 官方支持从某个分支的根目录或 `docs` 目录发布静态文件，参考[配置 Pages 发布源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)。本项目使用 `main` + `/(root)`：

1. 打开仓库 `Settings` → `Pages`。
2. 在 `Build and deployment` → `Source` 选择 `Deploy from a branch`。
3. Branch 选择 `main`，Folder 选择 `/(root)`，保存。
4. 等待 Pages 显示部署完成，再打开站点 URL。
5. 首次在 iPhone 上使用时，用 Safari 打开 HTTPS 地址，分享 → `添加到主屏幕`。

当前仓库包含空的 `.nojekyll` 文件，并随根目录静态文件发布。它用于明确告知 Pages 按静态文件处理；它不是密钥，也不替代 Pages 发布源设置。若未来改用 Jekyll、`gh-pages` 分支或外部 CI，应按新的发布源重新核验，而不是沿用旧说明。

## 发布前检查

- 只把已经通过测试并合并到 `main` 的版本作为 Pages 发布版本；开发分支不应被当作线上版本。
- HTML、Manifest、Service Worker、图片和图标使用相对路径，兼容 `/stardew-todo/` 子路径。
- 运行 `git diff --check`，检查没有真实密钥、临时调试代码或不应发布的备份。
- 在浏览器直接检查 `index.html`、`manifest.webmanifest`、`sw.js` 和关键图片均返回 200。
- 首次加载、刷新、关闭网络后的应用壳和 Service Worker 控制状态分别核验；“新 SW 已安装”不等于“页面已经由新版本控制”。

## 更新应用

修改合并到 `main` 后，Pages 会按仓库设置重新发布。V1.0 的页面应检测新 Service Worker，并在不打断正在编辑的任务时显示温和的“有新版本”提示；用户确认后再 `skipWaiting`/刷新。不要仅修改缓存名就宣称更新提示已经完成。

发布后至少核对：

1. Pages 构建完成；
2. 页面响应对应目标提交；
3. Service Worker 新版本已安装并在下一次页面生命周期接管；
4. 关键资源和项目子路径访问正常；
5. 若接入 Worker，Pages 可访问配置的 Worker API，且 CORS、健康检查和鉴权均正常。

## iPhone 主屏幕与通知边界

Web Push 在 iPhone/iPad 上需要用户把网站添加到主屏幕，并依赖 iOS/iPadOS 16.4 及以上的 WebKit 支持；详见 WebKit 的 [Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)。权限必须由用户明确点击“开启通知”后申请，不能在首次打开页面时弹出。PC 浏览器、Safari 和 iPhone 的前台/后台/关闭状态要分别测试，不能把桌面浏览器通知结果外推为 iPhone 真机已验证。

## Cloudflare Worker 的独立发布

GitHub Pages 只发布前端静态文件，不会发布 `worker/` 中的 Worker，也不会创建 D1、Secrets 或 Cron。仓库当前有 `.github/workflows/deploy-worker.yml` 作为 Worker 自动部署目标，但是否成功运行仍要看 Actions run、Worker deployment、D1 migration 和 health 响应。Worker 部署、D1 迁移、VAPID Secrets 和 CI 说明见 [`DEPLOYMENT.md`](./DEPLOYMENT.md)。不能把“Pages 已发布”描述成“Cloudflare 后端已部署”。

## 当前数据边界

- 本机 IndexedDB 是本机任务主数据；删除站点数据、卸载并清理网站数据或更换设备可能导致本地任务丢失。
- V1.0 的 D1 是共享任务镜像，不是完整 Todo 云数据库，也不是本地任务的无条件备份。
- 要迁移本机完整任务与设置，使用应用内 JSON 导出或本地备份恢复，并在导入前确认目标设备和覆盖范围。
