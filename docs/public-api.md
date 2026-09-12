# 千千结公开读取 API

千千结在 SillyTavern 主页面提供一个版本化的只读全局桥：

```js
const bridge = globalThis.qqj_v3_public_bridge_v1;
```

它只读取当前聊天。调用方不能通过该桥切换聊天、修改记忆、启动摘要或人物状态分析，也不能要求千千结自动补齐尚未加载的数据。

界面中的调用说明和复制示例位于“设置 → 教程与配置文件 → API 接口”。

## 三个方法

### `getStatus()`

同步返回桥和当前聊天身份的状态。`status: 'ready'` 只表示千千结已启用且当前聊天身份可用，不表示摘要、CSE 和人物档案已经全部加载。

```js
const status = bridge.getStatus();
```

可能的主要结果：

- `ready`：可调用其他读取方法，并带有 `identity`。
- `disabled`：千千结当前已关闭。
- `not-ready`：当前聊天身份仍未准备好。

### `readMemory()`

异步读取适合放进提示词的千千结记忆文本。它保留原有接口和返回格式，可能需要读取后端。

```js
const result = await bridge.readMemory();
if (result.status === 'ready') {
  console.log(result.text);
}
```

### `getSnapshot()`

同步读取当前已经加载在千千结内存里的结构化快照，不发网络请求，不调用模型，不刷新或重算任何数据。

```js
const snapshot = bridge.getSnapshot();

if (snapshot.status === 'ready') {
  const summaries = snapshot.memory.floors;
  const currentStates = snapshot.cse.currentSubjects;
  const cseHistory = snapshot.cse.floors;
  const people = snapshot.people.items;
}
```

每次返回的都是独立深复制。调用方修改其中的数组、人物档案或 CSE 条目，不会修改千千结内部状态。

## `getSnapshot()` 顶层结构

```js
{
  status: 'ready',
  identity: {
    hostChatId,
    qqjChatId,
    characterLocator,
    personaLocator
  },
  memory: { /* 摘要 */ },
  cse: { /* 人物状态 */ },
  people: { /* 千人档案 */ }
}
```

- `hostChatId` 是 SillyTavern 当前聊天标识。
- `qqjChatId` 是千千结用于隔离数据的当前聊天 UUID。
- `characterLocator` 和 `personaLocator` 标识当前角色与 Persona。
- 顶层 `ready` 只表示当前身份可读。三个业务分区必须分别判断自己的状态。
- 插件关闭或身份未准备好时，返回与 `getStatus()` 相同的 `disabled` / `not-ready` 结果，不会读取业务运行时。
- 某个内部读取意外失败时返回 `status: 'error'`、简短 `message` 和当前 `identity`。

千千结还会核对各分区的聊天身份。尚未加载、属于其他聊天或当前不可用的分区返回空数组，不会触发后台准备或把上一聊天的数据交给调用方。

## 摘要分区 `memory`

```js
{
  status,
  syncStatus,
  headCheckpointId,
  floors: [{
    floorId,
    messageIndex,
    assistantSeq,
    summary,
    summarySource
  }]
}
```

- `status` 来自千千结的 `memorySnapshotStatus`，表示当前已加载快照是否可读；常见值为 `ready`、`syncing`、`unavailable` 或 `error`。分区尚未加载或聊天归属不匹配时为 `not-ready`。
- `syncStatus` 来自 `memorySyncStatus`，表示后台核对状态。后台同步不等于已保存快照失效。
- `headCheckpointId` 是当前已加载记忆快照的 checkpoint 标识；不可用时为 `null`。
- `floors` 只含已经正式保存且仍有效的摘要。某楼正在重新分析时，只要旧摘要仍有效，旧摘要也会继续返回。
- `summary` 是当前有效摘要的完整原字符串，保留换行，不会再次裁剪或概括。
- `summarySource` 通常为 `user` 或 `ai`；人工摘要优先于 AI 摘要。
- `messageIndex` 是 SillyTavern 聊天中的实际楼号；`assistantSeq` 是仅按 AI 消息计算的顺序号，两者不能互换。

未加载快照时，`floors` 为空。已加载但当前聊天确实没有摘要时，`status` 可以是 `ready` 且 `floors` 为空。

## 人物状态分区 `cse`

```js
{
  ready,
  currentSubjects: [{
    subjectEntityId,
    displayName,
    core,
    adaptive,
    situational
  }],
  floors: [{
    floorId,
    messageIndex,
    assistantSeq,
    status,
    deltaId,
    changesKnown,
    changes,
    savedSubjects
  }]
}
```

`ready` 表示已经保存且有效的摘要是否都有对应 CSE。摘要本身仍可能有缺口；它为 `false` 时，`currentSubjects` 或 `floors` 也可能包含已经保存的部分结果，调用方不应因此丢弃这些数据。

### 当前状态与逐楼历史

- `currentSubjects` 是按现有身份合并结果重放出的当前人物状态。
- `floors` 是逐楼保存的 CSE 状态和变化历史。
- `savedSubjects` 是该楼记录自身保存的状态快照，不是从第一楼累计到该楼的完整人物当前态。
- `status` 可能包括 `ready`、`noChange`、`pending`、`running`、`failed` 或 `notApplicable`。
- `deltaId` 是该楼已保存的状态变化记录标识；没有记录时为 `null`。

逐楼变化有两种需要明确区分的情况：

- `changesKnown: true` 且 `changes: []`：该楼已确认没有逐项变化。
- `changesKnown: false` 且 `changes: null`：旧记录没有保存可核对的逐项变化，含义是未知，不等于零变化。

已知变化按人物分组：

```js
changes: [{
  subjectEntityId,
  displayName,
  changes: [{ category, action, before, after }]
}]
```

`category` 对应 `core`、`adaptive` 或 `situational`；`action` 为 `add`（增加）、`update`（更新）、`refine`（调整）或 `remove`（移除）。`before` / `after` 使用下述状态条目结构，某一侧不存在时为 `null`。

### 状态条目

`core`、`adaptive`、`situational`，以及变化中的 `before` / `after` 都由以下字段组成：

```js
{
  id,
  text,
  visibility,
  reason,
  origin,
  towardEntityId,
  towardDisplayName,
  sourceFloorId,
  sourceAssistantSeq
}
```

- `id` 在来源条目未提供标识时为 `null`；当前逐楼历史快照和变化也可能不带 `id`。
- `text` 是状态正文，`reason` 是已保存依据。
- `visibility` 保留原有知情边界；调用方不应把私密认知改写成其他人物已知事实。
- `origin` 表示条目来源类型。
- `towardEntityId` / `towardDisplayName` 表示有明确指向的人物；无指向时为 `null`。
- `sourceFloorId` / `sourceAssistantSeq` 标记来源楼；旧记录缺失时为 `null`。

## 人物档案分区 `people`

```js
{
  status,
  revision,
  items: [{
    entityId,
    displayName,
    entityDisplayName,
    aliases,
    specialRole,
    selected,
    profiled,
    profile
  }]
}
```

- `status` 保留人物工作区当前状态，例如 `idle`、`loading`、`ready`、`savingSelection`、`savingProfile`、`savingAvatar`、`merging`、`deleting` 或 `generating`。处理中已有的列表仍可读取。
- `revision` 是人物工作区自己的版本号，与记忆 checkpoint 不同；未加载时为 `null`。
- `items` 复用“千人”页面的有效人物列表，已经应用人物合并、删除和身份投影，并排除用户本人。
- `entityId` 是人物稳定标识。CSE 中同一人物可用 `subjectEntityId` 对应，但并非每个 CSE 人物都一定已经进入千人列表或拥有档案。
- `displayName` 是应用有效档案名称后的显示名，`entityDisplayName` 是实体目录显示名，`aliases` 是当前别名数组。
- `specialRole` 标记角色卡等特殊身份；普通人物通常为 `null`。
- `selected` 表示是否已在“千人”中关注，`profiled` 表示是否已有档案。
- 未建档人物的 `profile` 为 `null`。

已有 `profile` 包含以下正文字符串字段：

| 字段 | 含义 |
| --- | --- |
| `name` | 正式姓名或最稳定主要称呼 |
| `aliases` | 长期别名、昵称、代称与头衔 |
| `gender` | 有明确依据的性别 |
| `age` | 有明确依据的实际年龄或年龄设定 |
| `birthday` | 出生日期、生日或对应纪念日 |
| `species` | 种族、物种或非人类别 |
| `notes` | 无法归入其他字段的稳定补充资料 |
| `height` | 身高或相对身高 |
| `build` | 骨架、体态、比例或胖瘦等体型 |
| `face` | 脸型、五官、肤色与面部观感 |
| `hair` | 发型、发色与发质 |
| `eyes` | 瞳色、眼型与目光特征 |
| `distinctiveFeatures` | 伤疤、纹身、气味、声音等辨识特征 |
| `clothingStyle` | 长期衣着风格或固定装束 |
| `appearance` | 其他必要外貌补充 |
| `occupation` | 职业、工作或长期专业职责 |
| `organization` | 所属、效忠或任职组织与阵营 |
| `socialIdentity` | 社会地位、公开身份、阶层或头衔 |
| `background` | 出身、成长、教育与关键过往 |
| `identityRelations` | 亲属、师徒、上下级等身份关系 |
| `personality` | 跨情境较稳定的核心性格 |
| `conduct` | 处理事务、决策与冲突的稳定方式 |
| `expression` | 稳定说话、语气与表达习惯 |
| `likes` | 持续偏好、兴趣或珍视对象 |
| `dislikes` | 持续反感、畏惧、禁忌或排斥事物 |
| `principles` | 稳定价值、原则与边界 |
| `nsfw` | 有明确依据且适合长期建档的成人向资料 |

`profile` 另含：

- `manualFields`：由用户人工保存的字段名数组。
- `source`：档案来源，通常为 `manual` 或 `generated`。
- `createdAt` / `updatedAt`：档案创建和更新时间。

公开快照不包含头像、人物整理进度、原始模型结果、API 设置、错误日志、宿主聊天正文或世界书内容。
