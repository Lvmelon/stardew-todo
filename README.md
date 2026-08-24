# 今日任务 · 像素田园待办（GitHub Pages 版）

这是一个零后端、可安装到 iPhone 主屏幕的静态 PWA 待办应用。

## 当前功能

- 像素田园任务公告板
- 新增 / 查看 / 编辑 / 删除 / 完成任务
- 完成任务星光反馈
- IndexedDB 本地持久化，失败时自动降级
- Service Worker 离线缓存
- PWA Manifest 与 iPhone 主屏幕图标
- 兼容 GitHub Pages 项目子路径部署

## 免费部署

请看 [`GITHUB-PAGES-DEPLOY.md`](./GITHUB-PAGES-DEPLOY.md)。

关键点：

- 仓库需要设为 **Public**，才能在 GitHub Free 下免费使用 Pages。
- `manifest.webmanifest`、Service Worker 和所有资源均使用相对路径，因此可以发布到 `https://用户名.github.io/仓库名/`。
- `.nojekyll` 必须保留。

## 数据说明

当前没有服务器。任务只存在当前浏览器 / PWA 的本地 IndexedDB 中。

因此：

- 同一台 iPhone 上关闭再打开，数据仍会保留。
- 没网时仍可使用已缓存应用。
- 换手机或清除网站数据时，当前版本不能自动恢复。
- 当前版本没有 Web Push 到点提醒和跨设备同步。
