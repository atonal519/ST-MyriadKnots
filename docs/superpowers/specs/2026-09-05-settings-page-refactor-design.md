# 千千结设置页重构 · 设计规格

日期：2026-09-05
状态：已随效果图逐轮评审并获批（mockups/settings-redesign.html）

## 动机

现状设置页是 `src/ui/panel.js` 中一个约 200 行的 `renderSettings` 函数，五个抽屉同级平铺、无分层、间距松散、字号混乱、按钮被 grid 拉满宽。需要：重做视觉分层、修复具体样式问题、并把设置代码拆成聚焦模块。同时按用户要求修正若干行为。

## 最终信息架构

```
设置页
├─ 总开关　（standalone，始终可见，不折叠；左侧描红细线，主控级视觉权重）
│    └─ 启用千千结
│
├─ 通用设置　（顶层抽屉，默认关闭）
│    ├─ ① API 配置
│    ├─ ② 世界书排除
│    ├─ ③ 提示词与包裹符
│    └─ ④ 外观
│
└─ 记忆设置　（顶层抽屉，默认关闭；为将来更多记忆项预留）
     └─ 记忆提取周期
```

所有抽屉（顶层与子级）默认关闭。

## 逐模块改动

### 总开关
- 只保留「启用千千结」开关。删除原有的说明 hint。
- 原本挂在总开关下的「自动维护追平后的新楼」整块**移除**（见记忆设置）。

### ① API 配置（通用设置内第一项）
- 两个选择器改名：
  - `分析API（建议高质模型）` ← 现「主API / 人物整理使用」（`mainSelect`）
  - `摘要API（建议快速模型）` ← 现「副API / 历史扫描·人设补全使用」（`utilitySelect`）
- 其下一条**无标签分割线**。
- 预设编辑区顺序：URL → Key → 模型。
  - 模型字段旁增加「拉取模型」按钮，调用现成的 `apiTools.fetchModels`，把结果填/选进模型。
  - **移除「清除 Key」按钮。**
- 按钮排：`保存设置` `另存为预设` `测试连接`。此区**保留手动保存语义**（只针对 API 本身）。
- 抽屉【高级设置】（第三层，虚线分隔，左对齐）：排除参数、流式请求、超时秒数。

### ② 世界书排除（原「当前聊天 · 世界书来源」）
- 抽屉改名「世界书排除」。
- **只保留「整本排除」**：列出当前聊天挂载的世界书，逐本勾选=整本排除。
- 拆除的前端设置 UI（仅前端，核心建档逻辑不动）：
  - 「当前列表全部条目」总开关
  - 逐本分组（`source-book-group`）、逐条 `setEntryAllowed` 开关、「查看全文」
- 删除顶部 hint 和每本下面「勾选后构画与千千结都会整本排除」小字。
- 搜索框保留（过滤书名）。

### ③ 提示词与包裹符
- 字段保留（keepTags / extraTags / generalPrompt）。
- 删除底部「机器 JSON 合同…」说明句。

### ④ 外观
- **删除「字体 family」字段**（`appearanceFontFamily` 不再由用户填写）。
- 只保留「自定义字体 CSS URL」；字体名从该 CSS 自动解析。
- 主题、界面缩放保留。
- 删除「字体名会自动识别…」说明句（行为保留，只去掉文案）。

### 记忆设置（新顶层抽屉）
- 记忆提取周期：单一字段「每 N 楼提取一次记忆」，说明在上、收窄数字框在下（64px、去 number spinner、纯手填、min 1、默认 2）。
- **删除「启用自动记忆」开关**。

## 行为改动（真代码逻辑）

### A. 全局即时存储
- 除 API 预设编辑区（保留手动 保存/另存/测试）外，其余所有设置项**改即存**：
  - 外观（主题/缩放/字体URL）：change 即 `settings.update` + `applyArchiveV2Appearance`（顺带修复"主题选中不生效"——原来只在保存后应用）。
  - 提示词字段：change 即存。
  - API 的两个角色选择器（分析/摘要指向哪个预设）：change 即存。
  - 记忆提取周期数字：change 即存。
  - 世界书整本排除、总开关：已是即时。
- 移除设置页顶层统一的「保存设置」按钮（仅 API 区保留其自己的保存按钮）。

### B. 记忆自动提取由主开关统管
- **删除 `autoMemoryEnabled` 设置字段与其开关逻辑。**
- realtime 自动提取不再读 `automationSettings().enabled`（原=autoMemoryEnabled），改为**跟随主开关 `pluginEnabled`**。涉及 `index.js` 里两处 `automationSettings`（`v3MemoryRuntime`、`v3RecallRuntime`）。
- `autoMemoryBatchSize`（每 N 楼）保留为节奏，min 1、默认 2。
- 触发保持事件驱动（`MESSAGE_RECEIVED`），无新楼不触发；历史欠账仍走地基页手动重建——均不变。
- ⚠️ 默认行为变化：升级后只要千千结开着即自动对新楼提取（原默认关）。已获用户确认，符合"装上即用"意图。

### C. 字体从 CSS URL 自动识别
- `applyArchiveV2Appearance`：注入 `<link>` 后，`fetch(url)` 取 CSS 文本，正则提取第一个 `@font-face` 的 `font-family`，设为 `--qqj-custom-font`；解析结果缓存进 `appearanceFontFamily`（仍存储，但不再由用户编辑）避免重复 fetch。
- 跨域读不到/失败时回退系统字体，不报错。

### D. 拉取模型
- 接现成后端能力 `apiTools.fetchModels`（`compact-api-client.js` → `api-routing.js` 已实现），UI 露出按钮即可。

## 代码结构

把 `renderSettings` 从 `panel.js` 拆成聚焦模块（`src/ui/settings/` 下）：
- `settings-general-toggle.js`（总开关）
- `settings-api.js`（API 配置 + 高级设置）
- `settings-worldbook.js`（世界书排除，或直接精简 `archive-v2-source-permission-view.js` 的 `renderSettings`）
- `settings-prompts.js`（提示词与包裹符）
- `settings-appearance.js`（外观）
- `settings-memory.js`（记忆提取周期）
- `panel.js` 只做编排（组装分组抽屉、挂载各模块）。

复用现有 `createSettingsDrawer` / `createSettingsDrawerState`；新增顶层「分组抽屉 + 子抽屉」两级样式。

## 视觉系统

- 字号阶梯（全设置页共用）：页标题 20 / 组标题 14（宋体）/ 子抽屉 12.5（宋体）/ 字段标签 11 / 正文·输入 13 / 提示 10.5 / 按钮 12。
- 三层视觉权重：总开关（左红线主控卡）> 顶层分组抽屉（实心 panel 卡）> 子抽屉（无背景、细分隔线）。
- 间距收紧；按钮放进 flex `.actions`，不再被 grid 拉满宽；模型框与「拉取模型」等高对齐。
- 面板固定高、正文内部滚动（现状已具备，保持）。

## 保留 / 不动

- 各标签页内容 view（千人/千结/双丝网）、面板拖拽缩放、主题变量体系、共享 API 预设与七天插件的联动、世界书核心建档逻辑。
- 世界书 `renderPreflight`（建档前置）不在本次范围；若其"去筛选世界书"文案受影响再单独评估。

## 测试

- settings store：移除 `autoMemoryEnabled` 后的读写与迁移（老数据带该字段时忽略/清理）。
- API 角色选择 change 即存、字体 URL 解析（含失败回退）、拉取模型接线。
- 现有测试（settings-api、compact-api、v3-foundation-view 等）保持通过；受影响的断言相应更新。
