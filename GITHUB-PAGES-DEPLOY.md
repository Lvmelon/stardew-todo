# GitHub Pages 免费部署

这套文件已经按 GitHub Pages 的“项目站点”子路径方式处理，可部署到：

`https://<你的GitHub用户名>.github.io/<仓库名>/`

## 最简单的部署方式

1. 在 GitHub 新建一个 **Public** 仓库，例如 `stardew-todo`。
2. 把本目录里的所有文件上传到仓库根目录。**`.nojekyll` 也要保留。**
3. 打开仓库 `Settings` → `Pages`。
4. 在 `Build and deployment` 中选择 `Deploy from a branch`。
5. Branch 选择 `main`，Folder 选择 `/(root)`，保存。
6. 等待 GitHub Pages 发布完成，页面会显示访问地址。
7. 用 iPhone 的 Safari 打开该 HTTPS 地址。
8. 点击 Safari 分享按钮 → `添加到主屏幕`。

## 更新应用

以后直接修改仓库里的文件并提交即可。GitHub Pages 会重新发布。

Service Worker 使用了新的缓存版本；如果手机仍显示旧页面，可先删除主屏幕上的 Web App，再用 Safari 重新打开网址并添加一次。

## 当前能力边界

- 支持：新增、编辑、删除、完成任务、本地保存、离线缓存、主屏幕安装。
- 暂不支持：跨设备同步、服务器定时提醒、Web Push。
- 任务数据保存在当前浏览器 / PWA 的 IndexedDB 中；清除站点数据或卸载并清理网站数据可能导致任务丢失。
