const GUIDE_TITLE = '千千结使用说明';

const GUIDE_SECTIONS = [
  {
    title: '快速上手',
    open: true,
    paragraphs: [
      '先到“设置 → 通用设置 → API 配置”。分析 API 用于双丝网人物状态分析；摘要 API 还负责逐楼摘要、LLM 召回选材和千人人物资料整理。摘要 API 默认可选择“跟随分析 API”，也可以单独配置。在 API 配置页里，保存设置不发请求；“测试连接”或“拉取模型”会发出请求。',
      '新聊天正常对话即可逐步建立记忆，不需要先打开千千结面板。旧聊天可到“设置 → 记忆管理”手动补齐；空聊天还没有可保存的记忆属于正常情况。',
      '到“千人”选择重要人物。选择本身只保存关注名单；后续相关新楼和核心状态变化可在后台增量整理人物资料。',
    ],
  },
  {
    title: '健康条怎么看',
    paragraphs: [
      '健康条显示当前页面的进度：等待表示还没有满足处理条件；加载或处理中表示正在读取、摘要、分析或保存；缺少摘要或状态表示仍有楼层待补；暂停需要你手动继续；失败会保留原因并允许按页面提示重试；可用表示当前已加载的结果可以使用。',
      '“记忆尚未完整”不等于聊天为空。楼数和“已跟上”等文字只说明对应阶段的进度，不能当成所有后台任务都已完成。刷新状态只读取并核对现状，不调用模型，也不会自动恢复已暂停的历史任务。',
    ],
  },
  {
    title: '千人',
    paragraphs: [
      '“更多人物”用于选择重要人物；选择后可在人物页查看角色资料、头像和后台整理状态。已处理过的材料不会因为普通刷新再次整理；“整理待建档人物”“整理当前资料”和“重新整理资料”会调用摘要 API。',
      '原文资料可能分批进入整理。人工保存或清空的资料字段会优先保留；完全重构等明确的覆盖操作仍以操作前的确认说明为准。头像可在人物菜单中上传并裁剪。',
      '“合并到其他人物”会把双方历史楼、摘要和 CSE 映射到同一人物，但整份人物档案和头像需要二选一保留。“删除人物”会移除档案、头像、关注和当前候选展示，不删除旧楼、摘要或 CSE，也不会永久屏蔽这个名字。',
    ],
  },
  {
    title: '千结',
    paragraphs: [
      '千结按 AI 楼保存事件摘要。展开某楼可“提取摘要”“重新提取”或“编辑”；保存后每楼独立，修改只写入对应楼层。手改或重提本楼不会自动清空、重算 CSE，也不会改写其他楼。',
      '删除聊天正文楼后，状态核对会更新对应的宿主楼号，显示可能稍有延迟。楼号用于定位当前聊天，不是永远不变的记录编号。',
    ],
  },
  {
    title: '双丝网、CSE 与召回',
    paragraphs: [
      '摘要记录发生了什么；CSE 保存人物状态和关系怎样逐楼变化。双丝网显示关注人物的当前状态、关系和分析记录。当前楼没有新关系时，界面可能展示最后一次有记录的关系，并明确标注来源楼；这只是历史参照，不冒充本次召回结果。',
      '“事 / 人”召回和人物状态的时间推演会给 AI 当前回复提供参考，不会回写旧楼。当前一次召回得到 0 条可以是正常结果，也不表示历史摘要或人物档案为空。',
    ],
  },
  {
    title: '设置',
    paragraphs: [
      '总开关控制千千结是否工作。API 配置中可选择分析/摘要 API、模型与预设；主配置需要“保存设置”，测试和拉模型会请求服务。提示词、主题显示等页面字段在修改或恢复默认时会按界面现有行为即时保存。',
      '“世界书排除”用于搜索并勾选不让千千结读取的世界书，只改变千千结的资料来源，不会删除世界书。召回会在内部总预算内选材；“最近召回”可查看本次实际投入。',
      '“自动隐藏”在“设置 → 记忆设置”中开启，并可设置后续保留的最近 AI 楼数；它不会删除正文或记忆。',
      '“保留包裹符”会去掉标签并留下其中内容。要让模型参考状态栏，请把对应包裹符填入“保留包裹符”；未列入的成对标签内容会被排除。“清洗包裹符”会排除明确成对的标签及内部内容。未闭合或未配置的普通文字不会被猜测删除。改规则会改变正文认定，旧楼可能需要重新核对。故事时间默认读取千千结时间戳，也能兼容构画和旧千千结的既有时间信息。',
      '如目标楼带有已保存的 MVU / EJS 信息，千千结会将其作为只读辅助参考，不会改写这些变量。',
    ],
  },
  {
    title: '记忆管理',
    paragraphs: [
      '“前情”可粘贴一段大摘要并原样保存到当前聊天，不调用模型，也不会立刻改写旧记忆。之后召回会按话题在预算内选取片段；没有明显匹配时可参考末尾。CSE 和人物整理只在相关匹配时参考，首次人物建档通常读取范围更大。',
      '“最近召回”显示本次送给 AI 的记忆内容和估算 token。“设置 → 教程与配置文件”中的“API 接口”是给第三方脚本只读获取当前人物、摘要和 CSE 的调用说明，不是模型 API 配置。',
    ],
    items: [
      '“补齐缺失 / 继续补齐”：保留已有结果，先补摘要再做 CSE；页面刷新后需要手动继续。',
      '“完全重构”：替换当前聊天的摘要、CSE 及对应人工修订。',
      '“人物状态重构”：保留摘要，只重做已有摘要楼的 CSE，并覆盖 CSE 人工纠正；它使用自己的暂停 / 继续。',
      '“删除当前聊天记忆”：删除当前聊天的摘要、CSE 人物状态、人物资料、召回记录和历史派生版本；保留聊天正文、前情和全局设置。',
    ],
  },
  {
    title: '常见问题与诊断',
    paragraphs: [
      '摘要提取和 CSE 分析各自最多尝试 3 次，网络层内部尝试也计入各自总数；取消、配置错误等情况会立即停止，不一定凑满 3 次。摘要最终失败只跳过该楼，后续楼摘要继续；有摘要的楼仍可做 CSE。只有 CSE 自己最终失败才暂停 CSE 阶段，已经保存的结果不会被清空。',
      '正文召回遇到技术故障只重试 1 次，第二次仍失败会停止本次正文生成；正常得到 0 条召回则允许继续。暂停或刷新页面后，历史任务需要手动继续，不会自行恢复。',
      '健康条和楼层错误显示当前问题；“记忆管理 → 详细诊断”可查看阶段、后端请求耗时与次数等信息。同一浏览器中，按聊天保存的摘要 / CSE 失败提示会跨刷新保留，成功处理对应楼后才清除。完整诊断可能包含正文，复制或转发前请先自行检查。',
    ],
  },
];

function element(documentRef, tag, className = '', copy = '') {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (copy) node.textContent = copy;
  return node;
}

export function createHelpGuideContent(documentRef = globalThis.document) {
  const guide = element(documentRef, 'div', 'qqj-help-guide');
  guide.append(element(documentRef, 'p', 'qqj-help-guide-intro', '第一次使用可先看“快速上手”，其余内容按需展开。'));
  GUIDE_SECTIONS.forEach(section => {
    const details = element(documentRef, 'details', 'qqj-help-section');
    details.open = section.open === true;
    details.append(element(documentRef, 'summary', 'qqj-help-section-summary', section.title));
    const body = element(documentRef, 'div', 'qqj-help-section-body');
    section.paragraphs.forEach(copy => body.append(element(documentRef, 'p', '', copy)));
    if (section.items?.length) {
      const list = element(documentRef, 'ul', 'qqj-help-list');
      section.items.forEach(copy => list.append(element(documentRef, 'li', '', copy)));
      body.append(list);
    }
    details.append(body); guide.append(details);
  });
  return guide;
}

export function openHelpGuide({ documentRef = globalThis.document, customImpl } = {}) {
  if (typeof customImpl !== 'function') return Promise.resolve(false);
  return Promise.resolve(customImpl({
    title: GUIDE_TITLE,
    content: createHelpGuideContent(documentRef),
    confirmText: '关闭',
    cancelText: '',
    submit: () => true,
  }));
}
