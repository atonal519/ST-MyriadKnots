# 千千结设置页重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置页重做为「总开关 / 通用设置 / 记忆设置」三层结构，修复视觉与行为问题，并把 `renderSettings` 拆成聚焦模块。

**Architecture:** 保留 Shadow DOM + `createSettingsDrawer` 体系，新增两级分组抽屉。设置项改为即时存储（API 预设区除外）。记忆自动提取的开关由主开关统管（移除 `autoMemoryEnabled`）。字体从 CSS URL 自动解析。UI 逻辑从 `panel.js` 拆到 `src/ui/settings/` 下的模块。

**Tech Stack:** 原生 JS ES module、Vite（`npm run build` → `dist/qqj-app.js`）、node 内置 test runner（`npm test`）。UI 测试用手写 `documentRef`/`Node` 桩。

**Spec:** docs/superpowers/specs/2026-09-05-settings-page-refactor-design.md

## Global Constraints

- 酒馆实际加载 `dist/qqj-app.js`；任何 src 改动最终需 `npm run build` 重打包。
- 测试命令：`npm test`（`node --experimental-vm-modules --test tests/*.test.mjs`）。
- UI 组件必须接受注入的 `documentRef`（默认 `globalThis.document`），测试用桩注入，禁止依赖真实浏览器。
- 文案/命名按 spec：分析API（建议高质模型）、摘要API（建议快速模型）、世界书排除、记忆提取周期、每 N 楼提取一次记忆。
- 字号阶梯：页标题20 / 组标题14宋体 / 子抽屉12.5宋体 / 字段标签11 / 正文·输入13 / 提示10.5 / 按钮12。
- 所有抽屉默认关闭。API 预设区保留手动 保存/另存/测试；其余设置项 change 即存。
- git 提交由用户决定：**不要自行 commit/push**，除非用户明确要求。计划中的 commit 步骤视为可选检查点。

---

### Task 1: settings store 移除 `autoMemoryEnabled`

**Files:**
- Modify: `src/settings.js`（DEFAULT_SETTINGS、update()）
- Modify: `index.js:61-64, 74`（两处 `automationSettings`）
- Test: `tests/settings-api.test.mjs`

**Interfaces:**
- Produces: settings 不再有 `autoMemoryEnabled`；`autoMemoryBatchSize`（min 1, 默认 2）保留；`index.js` 的 `automationSettings().enabled` = `settings.isEnabled()`。

- [ ] **Step 1: 更新/新增测试** — 在 `tests/settings-api.test.mjs`（或 settings 相关测试）断言：`DEFAULT_SETTINGS` 不含 `autoMemoryEnabled`；`update({autoMemoryEnabled:true})` 不写入该键；`autoMemoryBatchSize` 默认 2、非法值回退 2。删除/改写引用 `autoMemoryEnabled` 的旧断言。
- [ ] **Step 2: 跑测试确认失败** — `npm test` → 相关用例 FAIL。
- [ ] **Step 3: 改 `src/settings.js`** — 从 `DEFAULT_SETTINGS` 删 `autoMemoryEnabled`；从 `update()` 删 `if (own(patch,'autoMemoryEnabled')) …` 那行。保留 `normalizeAutoMemoryBatchSize`（已 min 1 默认 2）。
- [ ] **Step 4: 改 `index.js`** — 两处 `automationSettings`：`enabled: settings.get().autoMemoryEnabled === true` → `enabled: settings.isEnabled()`。
- [ ] **Step 5: 跑测试确认通过** — `npm test`。
- [ ] **Step 6:（可选）提交检查点。**

---

### Task 2: 记忆 runtime 断言更新

**Files:**
- Test: `tests/archive-v2-memory-runner.test.mjs`、`tests/v3-recall.test.mjs`（若引用 enabled 语义）

**Interfaces:**
- Consumes: Task 1 的 `automationSettings().enabled = isEnabled()`。
- Produces: runtime 行为不变（仍靠 `automation().enabled` + `batchSize` 触发），仅测试注入方式对齐"enabled 跟随主开关"。

- [ ] **Step 1: 审查** — runtime 单测直接注入 `automationSettings`，不读 settings.js；确认它们不因 Task 1 破坏。`npm test` 观察。
- [ ] **Step 2: 如有失败** — 更新用例：把"关闭自动记忆"场景从 `autoMemoryEnabled:false` 改为 `isEnabled:false`（主开关关）；"开启"场景 `enabled:true`。
- [ ] **Step 3: 跑测试确认通过** — `npm test`。

---

### Task 3: 字体从 CSS URL 自动解析

**Files:**
- Modify: `src/ui/archive-v2-appearance.js`
- Test: `tests/archive-v2-prompt-appearance.test.mjs`

**Interfaces:**
- Produces: `applyArchiveV2Appearance({host,root,settings,documentRef,fetchImpl})` 同步应用主题/缩放，异步 fetch CSS 解析首个 `@font-face` 的 `font-family` → 设 `--qqj-custom-font` 并回写 `settings.update({appearanceFontFamily})` 缓存；失败回退 `system-ui`。新增可注入 `fetchImpl`（默认 `globalThis.fetch`）便于测试。返回 Promise 或同步对象仍含 `{theme,scale}`。

- [ ] **Step 1: 写失败测试** — 注入假 `fetchImpl` 返回含 `@font-face{font-family:'LXGW WenKai';src:...}` 的 CSS 文本；断言解析后 `--qqj-custom-font` 为 `"LXGW WenKai"`；再断言 fetch 抛错时回退 `system-ui` 不抛异常。已有缓存 `appearanceFontFamily` 时跳过重复 fetch。
- [ ] **Step 2: 跑测试确认失败** — `npm test`。
- [ ] **Step 3: 实现** — 保留现有主题/缩放同步逻辑与 `<link>` 注入。新增：URL 非空且缓存 family 为空/URL 变化时，`await fetchImpl(url).then(r=>r.text())`，正则 `/@font-face\s*\{[^}]*?font-family\s*:\s*(['"]?)([^;'"}]+)\1/i` 取 family，`host.style.setProperty('--qqj-custom-font', '"'+family+'"')`，`settings.update?.({appearanceFontFamily:family})`。try/catch 回退 `system-ui`。family 已缓存则直接用缓存。
- [ ] **Step 4: 跑测试确认通过** — `npm test`。
- [ ] **Step 5:（可选）提交检查点。**

---

### Task 4: 世界书视图精简为「世界书排除」

**Files:**
- Modify: `src/ui/archive-v2-source-permission-view.js`（`renderSettings`）
- Test: `tests/archive-v2-source-permission-view.test.mjs`

**Interfaces:**
- Consumes: `permissions.inspectCurrent()`、`permissions.setBookExcluded(book, bool)`。
- Produces: `renderSettings` 抽屉标题「世界书排除」，只渲染整本排除勾选 + 搜索框；不再渲染条目分组/逐条开关/查看全文/hint。`renderPreflight` 不变。

- [ ] **Step 1: 改测试** — 断言：抽屉标题为「世界书排除」；渲染后无 `.source-book-group`、无「当前列表全部条目」、无 `.source-entry-content`；整本排除勾选仍调用 `setBookExcluded`。删除针对条目开关的旧断言。
- [ ] **Step 2: 跑测试确认失败** — `npm test`。
- [ ] **Step 3: 实现** — `createSettingsDrawer` title 改「世界书排除」、id 保持 `qqj-settings-worldbook`；`draw()` 只保留整本排除列表（去掉每本 muted 小字），删掉 `allCurrent` 全选、`groups` 条目分组、`toggleRow` 的条目部分、`hint`。搜索框保留（过滤书名）。
- [ ] **Step 4: 跑测试确认通过** — `npm test`。
- [ ] **Step 5:（可选）提交检查点。**

---

### Task 5: 设置模块拆分骨架 + 通用/记忆非 API 模块

**Files:**
- Create: `src/ui/settings/appearance-settings.js`、`src/ui/settings/prompts-settings.js`、`src/ui/settings/memory-settings.js`、`src/ui/settings/general-toggle.js`
- Modify: `src/ui/panel.js`（`renderSettings` 改为编排）
- Modify: `src/ui/panel.css`（两级分组抽屉、字号阶梯、按钮、number spinner）
- Test: `tests/settings-drawers.test.mjs`（扩展）

**Interfaces:**
- Produces: 每个模块导出工厂 `create*Settings({settings, documentRef, onChange})` 返回 `{ node }`（一个 `<details class="sub">`），内部字段 change 即调用 `settings.update` 并即时应用（外观还调 `applyArchiveV2Appearance`）。`general-toggle` 返回主开关卡片节点及 `setEnabled` 联动。

- [ ] **Step 1: CSS** — 在 `panel.css` 增加：`.master-switch`（左红线卡）、`.group`/`.group-body`（顶层分组抽屉）、`.sub`/`.sub-body`（子抽屉，细分隔线）、`.field`/`.field-inline`/`.divider`/`.actions`/`.btn`（含 primary/secondary，flex 不满宽）、number spinner 隐藏、`.num{width:64px}`。字号按阶梯。参考 mockups/settings-redesign.html 的最终样式。
- [ ] **Step 2: appearance-settings.js** — 主题 select、缩放 range（output 实时百分比）、字体 CSS URL input（**无 family 字段**）。change 即 `settings.update` + `applyArchiveV2Appearance`。写桩测试：change 触发 update。
- [ ] **Step 3: prompts-settings.js** — keepTags/extraTags/generalPrompt 三字段，change 即存。无「机器 JSON」hint。
- [ ] **Step 4: memory-settings.js** — 单字段「每 N 楼提取一次记忆」，收窄 number（min 1 默认取 `autoMemoryBatchSize`），change 即 `settings.update({autoMemoryBatchSize})` + `onAutomationSettingsChange`。无开关。
- [ ] **Step 5: general-toggle.js** — 「启用千千结」开关，复用 `applyPluginEnabledImmediately` 逻辑（从 panel.js 迁入或接线）。
- [ ] **Step 6: 跑测试确认通过** — `npm test`。
- [ ] **Step 7:（可选）提交检查点。**

---

### Task 6: API 设置模块 + 拉取模型 + panel 编排

**Files:**
- Create: `src/ui/settings/api-settings.js`
- Modify: `src/ui/panel.js`（组装：master + 通用设置 group[api/worldbook/prompts/appearance] + 记忆设置 group）
- Modify: `index.js`（若 `apiTools.fetchModels` 需透传到 panel —— 已在 `apiTools`，确认 panel 已拿到 `apiTools`）
- Test: `tests/settings-api.test.mjs`、`tests/settings-drawers.test.mjs`

**Interfaces:**
- Consumes: `settings`（sharedPresets/sharedMainConfig/upsertSharedPreset/saveSharedMainConfig/setSharedUtilityPresetId 等）、`apiTools.testConnection`、`apiTools.fetchModels`。
- Produces: `createApiSettings(...)` 返回 `<details class="sub">`：分析API/摘要API 两 select（change 即存角色指向）→ 分割线 → URL/Key/模型（模型旁「拉取模型」）→ actions[保存/另存/测试] → 【高级设置】子抽屉[排除参数/流式/超时]。**无清除 Key。**

- [ ] **Step 1: 写测试** — 断言：`fetchModels` 按钮点击调用 `apiTools.fetchModels` 并把返回模型填入模型输入/下拉；无「清除 Key」按钮；保存按钮仍走 `upsertSharedPreset`/`saveSharedMainConfig` 分支（沿用现逻辑）。
- [ ] **Step 2: 跑测试确认失败** — `npm test`。
- [ ] **Step 3: 实现 api-settings.js** — 迁移 panel.js 现有 API 逻辑；改名两 select（分析=main、摘要=utility）；顺序 URL→Key→模型；模型行用 `.field-inline` 加「拉取模型」按钮（调用 `apiTools.fetchModels`，成功填模型、失败提示）；删 keyClear；把 排除参数/超时/流式 放进【高级设置】子抽屉；actions 用 `.btn`。角色 select change 即 `settings.update`/`setSharedUtilityPresetId`。
- [ ] **Step 4: 改 panel.js `renderSettings`** — 改为编排：`page` 依次 append master-switch、通用设置 group（内挂 api / worldbook(source view) / prompts / appearance 四个 sub）、记忆设置 group（内挂 memory sub）。删除原顶层统一「保存设置」按钮（仅 API 区保留）。删除迁走的内联代码。
- [ ] **Step 5: 跑测试确认通过** — `npm test`。
- [ ] **Step 6:（可选）提交检查点。**

---

### Task 7: 全量测试 + 打包 + 冒烟

**Files:** 无新增

- [ ] **Step 1: 全量测试** — `npm test`，全绿。修复任何回归。
- [ ] **Step 2: 打包** — `npm run build`，确认 `dist/qqj-app.js` 更新无报错。
- [ ] **Step 3: 冒烟** — `tests/production-entry-load.test.mjs` 若覆盖入口加载则确保通过；否则人工核对无 import 遗漏。
- [ ] **Step 4: 效果核对** — 对照 mockups/settings-redesign.html：三层结构、默认全关、分析/摘要命名、拉取模型、无清除Key、世界书排除、记忆单字段、字体无 family、按钮不满宽。
- [ ] **Step 5:（可选）交由用户决定 git 提交。**

## Self-Review

- **Spec coverage:** 总开关(T5) / 通用设置分组(T6) / API 改名·分割线·拉取模型·去清除Key·高级设置(T6) / 世界书排除(T4) / 提示词去小字(T5) / 外观去 family + 字体URL解析(T3,T5) / 记忆单字段去开关(T1,T5) / 即时存储(T5,T6) / 记忆跟随主开关(T1,T2) / 代码拆分(T5,T6) / 视觉系统(T5) / 打包(T7) — 均有任务覆盖。
- **Placeholder scan:** 无 TBD/TODO；tricky 处（字体正则、fetchModels 接线、automationSettings 改法）已给具体做法。
- **Type consistency:** `automationSettings().enabled` 全链一致；`createApiSettings/createMemorySettings/...` 命名一致；`appearanceFontFamily` 作为缓存字段名一致。
