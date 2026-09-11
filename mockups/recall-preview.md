# 召回框本地预览

在仓库根目录运行 `node mockups/serve-recall-preview.mjs`，打开
<http://127.0.0.1:4173/mockups/recall-preview.html>。

无需安装酒馆或构建依赖。预览模拟宿主与召回数据，直接调用
`src/ui/inline-renderer.js` 和 `src/ui/recall-tabs.js`；修改源码后刷新页面即可。

可切换剧情线/旧版回执、空记录、运行中、失败场景，以及深浅色和手机宽度。
事页签中的胶囊默认关闭，单选共用正文区；人页签的当前状态常驻，
变化按人物切换、按楼层折叠。`QQJ_PREVIEW_PORT` 可覆盖默认端口 4173。
