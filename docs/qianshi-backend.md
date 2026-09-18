# 千事后端接口合同

千事把每个有效 FloorMemory 上的可选 `qianshiDelta` 作为唯一持久事件增量。Graphology 图只由当前聊天中仍可达、仍有效的 FloorMemory 重放得到，不单独保存第二份事件账本。

## 摘要同次输出

新楼仍只调用现有摘要 API。请求 `payload.qianshiCandidates` 提供与本楼人物、当前故事时间和未完事项相关的旧事项候选；候选键是本次请求内的 `candidate-N`，模型不得输出后端 UUID。

响应可选字段：

```json
{
  "summary": "原有摘要",
  "qianshi": {
    "events": [
      {
        "key": "event-1",
        "title": "晚饭安排",
        "description": "众人约定晚饭后继续讨论",
        "status": "planned",
        "storyTime": "当晚",
        "scheduledTime": "晚饭后",
        "people": ["人物名"],
        "object": "讨论安排",
        "matter": true,
        "links": [{ "candidateKey": "candidate-1", "kind": "progress" }]
      }
    ],
    "order": [
      { "before": "candidate-1", "after": "event-1", "certainty": "explicit" }
    ]
  }
}
```

`qianshi` 缺失、格式错误或部分条目错误不会令摘要重试。编译结果区分：

- `ready`：存在有效事件，且本楼千事字段已完整处理。
- `empty`：模型明确返回空事件，表示本楼已检查但没有事件增量。
- `partial`：保留合法事件，同时记录未能编译的条目数和简短原因。
- `pending`：字段缺失或整体无效，摘要照常保存，本楼可由手动历史任务补齐。

事件 ID 与事项 ID 由程序生成。一次性日常事件可以只有事件而没有事项 ID。模型只能用本批 `event-N` 和输入 `candidate-N` 建立关系；`progress` 推进当前状态，`context` 只表示同一事项的倒叙补证或背景。同一对象的不同安排默认是不同事项实例。

## FloorMemory 增量

新字段为可选 `qianshiDelta`。旧 FloorMemory 没有该字段时仍可读取，含义是“尚未整理千事”。`qianshiDelta` 保存：

- 编译状态、原因和覆盖时间；
- 本楼新增事件及其来源楼；
- 事件推进的事项实例；
- 明确的事项接续和时间先后关系；
- 本次候选数量与字符规模。

普通摘要文字修订保留原 delta；主动重提使用新结果。时间元数据真正变化时把该楼 delta 标成 `pending`，不影响摘要或 CSE。

## 公开桥

现有 `globalThis.qqj_v3_public_bridge_v1` 保持原样。千事使用独立桥：

```js
const bridge = globalThis.qqj_qianshi_backend_v1;
```

### `getStatus()`

同步返回当前已加载快照的状态、锚点、覆盖率和历史任务状态，不刷新后端、不调用模型。

### `getSnapshot()`

同步返回当前已加载快照的深复制：

```js
{
  status: "ready",
  identity: { qqjChatId },
  anchor: { narrativeGeneration, headCheckpointId, rootRevision },
  coverage: {
    eligibleFloors,
    readyFloors,
    emptyFloors,
    completeFloors,
    partialFloors,
    pendingFloors,
    degradedFloors,
    unavailableFloors
  },
  events: [],
  matters: [],
  relations: [],
  currentProgress: { text, characterCount, eventIds, matterIds },
  history: { status, jobId, processedFloors, totalFloors, calls, message }
}
```

`events` 字段为 `id`、`matterId`（独立日常事件为 `null`）、`updatesMatter`、`title`、`description`、`status`、`storyTime`、`scheduledTime`、`people[{entityId,name}]`、`object`、`sourceFloorId`、`sourceFloorMemoryId`、`sourceAssistantSeq`。

`matters` 字段为 `matterId`、`title`、`description`、`status`、`object`、`people`、`storyTime`、`scheduledTime`、`origin{eventId,title,description,storyTime,scheduledTime,sourceFloorId,sourceAssistantSeq}`、`latestEventIds`、`eventIds`、`sourceFloorId`、`sourceAssistantSeq`。`relations` 字段为 `id`、`type`（`progress` 或 `before`）、`fromEventId`、`toEventId`、`certainty`。调用方拿不到 Graphology 实例或内部可变对象。

`currentProgress` 仍是供公开读取和前端展示的详细进度快照，不直接等于正文注入。正文生成会从同一可达图另行投影短版：`[相关时间线]` 只保留本轮查询命中的事项及其已有 progress 链关键节点，`[当前待接续]` 只保留正文故事时钟附近且状态仍为 planned / inProgress 的事项，并统一表述为“尚未记录完成”。scheduledTime 仅作为约定期限，不作为已经发生的时间。该投影不修改事件、事项、关系或公开快照。

### `read()`

异步返回调用时当前已加载快照的深复制。它不刷新后端、不调用模型、不启动历史任务；调用方可用 `anchor` 判断快照是否仍适用。

### `prepareHistory(options?)`

异步只读规划历史补齐，不调用模型：

```js
await bridge.prepareHistory({
  maxInputTokens: 70000,
  maxOutputTokens: 30000
});
```

`maxInputTokens` 是可调批次容量，当前默认 70000；`maxOutputTokens` 当前默认 30000。结果包含可处理楼、因缺 FloorMemory 而不可处理楼、预计批次、预计 API 调用数和保守的输入 token 上界。规划时每批只预留一次共享候选池容量；执行时同一旧事项候选在批内去重，并用实际请求重新核对容量。完整楼正文不会仅为凑固定楼数而截断；若单楼正文自身已经超过容量，该楼仍作为一个完整批次处理。

### `startHistory(planId)`

显式执行最近一次仍有效的计划。每个批次至多一次模型请求，无自动格式重试；逐楼编译并只替换对应 FloorMemory 的 `qianshiDelta`，已有摘要及人工字段逐字保留。成功楼立即保存，失败和未处理楼可继续。

### `stopHistory()`

停止当前历史任务。已保存楼保持有效；再次 `prepareHistory()` / `startHistory()` 不重发已经完整覆盖的楼。

## 成本与状态边界

- 新楼：千事不增加摘要之外的 API 调用。
- 旧楼：预计调用数等于规划批次数，不按人物或单楼拆请求。
- `getStatus()`、`getSnapshot()`、`read()`、`prepareHistory()` 均不调用模型。
- 只有显式 `startHistory(planId)` 可以触发旧楼历史模型请求。
- 读取、打开前端或订阅状态不会自动启动历史任务。
