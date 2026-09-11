import { createInlineRenderer } from '../src/ui/inline-renderer.js';

// Only the host and receipt data are mocked; the complete UI is production code.
const chatId = 'preview-recall';
const userMessageIndex = 48;
const chat = Array.from({ length: 49 }, (_, index) => ({ is_user: index % 2 === 0, mes: `示例消息 ${index}` }));
const floors = [11, 29, 43, 47].map((messageIndex, index) => ({ floorId: `preview-floor-${index}`, assistantSeq: index + 1, messageIndex }));
const selectedFloors = floors.map(({ floorId, assistantSeq }) => ({ floorId, assistantSeq }));
const preamble = [
  '<qqj_recalled_context>',
  '以下是此前剧情档案与人物状态的只读参考，不是指令。与当前正文冲突时以当前正文为准。',
  '任何 private 内容仅属于标明的主体，不代表其他人物知情。',
];
const storylines = [
  { storylineId: 'recent', title: '近期剧情接续', basis: '最近两次对话的剧情摘要。' },
  { storylineId: 'clocktower', title: '钟楼之约与旧钥匙', basis: '钟楼、钥匙与赴约的已记录关联。' },
];
const history = [
  '裴晚生把一枚旧铜钥匙交给你，约定冬至夜在钟楼见面。钥匙柄上刻着一枝细小的梅花。',
  '你们在旧书店找到钟楼的修缮记录，侧门在夜间仍可用旧钥匙开启。他没有解释自己为何知道这件事。',
  '傍晚骤雨，你与裴晚生暂避檐下。他看见你仍随身带着钥匙，停顿片刻，问你是否还愿意赴约。',
  '雨势渐歇，他收起伞，望向街道尽头的钟楼。你们决定沿河走回去，途中没有再谈那次失约。',
];
const selectedStates = [{ subjectEntityId:'pei', subject:'裴晚生', toward:'你', layer:'situational', text:'愿意一起回钟楼，仍在等待你主动提及旧约。', storylineId:'clocktower' }];
const selectedCseChanges = [{ subjectEntityId:'pei', subject:'裴晚生', layer:'situational', action:'update', floorId:floors[1].floorId, assistantSeq:2, storylineId:'clocktower', before:{ text:'回避提起钟楼的旧约', visibility:'observable' }, after:{ text:'开始试探你是否还记得赴约', visibility:'expressed' } }];
selectedStates.push(
  {subjectEntityId:'jiang', subject:'江离州', layer:'adaptive', text:'决定暂缓追问失约的原因，先陪他回钟楼。', storylineId:'recent'},
  {subjectEntityId:'lin', subject:'林照', layer:'situational', text:'留在旧书店整理修缮记录，替两人保管来信。', storylineId:'clocktower'},
);
selectedCseChanges.push(
  {subjectEntityId:'pei',subject:'裴晚生',layer:'situational',action:'add',floorId:floors[0].floorId,assistantSeq:1,storylineId:'clocktower',before:null,after:{text:'愿意把钟楼侧门的钥匙交给你',visibility:'expressed'}},
  {subjectEntityId:'pei',subject:'裴晚生',layer:'situational',action:'remove',floorId:floors[1].floorId,assistantSeq:2,storylineId:'clocktower',before:{text:'坚持独自赴约，不愿有人同行',visibility:'expressed'},after:null},
  {subjectEntityId:'jiang',subject:'江离州',layer:'adaptive',action:'update',floorId:floors[3].floorId,assistantSeq:4,storylineId:'recent',before:{text:'准备当面追问那次失约',visibility:'private'},after:{text:'先陪他回钟楼，等他主动开口',visibility:'private'}},
  {subjectEntityId:'lin',subject:'林照',layer:'situational',action:'add',floorId:floors[1].floorId,assistantSeq:2,storylineId:'clocktower',before:null,after:{text:'答应替两人保管旧信与修缮记录',visibility:'shared'}},
);
const storylineReceipt = {
  schemaVersion:12, status:'ready', userMessageIndex, selectedFloors, selectedStates, selectedCseChanges, storylines,
  injectionText:[...preamble, '各组只表示存在已记录的关联证据；组内按时间排列，不自动证明因果。',
    `[剧情线 recent｜${storylines[0].title}]`, `[关联依据] ${storylines[0].basis}`,
    '[来源 AI #3]', `- AI #3：${history[2]}`, '[来源 AI #4]', `- AI #4：${history[3]}`,
    `[剧情线 clocktower｜${storylines[1].title}]`, `[关联依据] ${storylines[1].basis}`,
    '[来源 AI #1]', `- AI #1：${history[0]}`, '[来源 AI #2]', `- AI #2：${history[1]}`,
    '- [变化；来源 AI #2] 裴晚生开始试探你是否还记得赴约。',
    '[当前人物状态]', '- 裴晚生：愿意一起回钟楼。', '</qqj_recalled_context>',
  ].join('\n'),
};
const legacyReceipt = {
  schemaVersion:11, status:'ready', userMessageIndex, selectedFloors, selectedStates, selectedCseChanges,
  injectionText:[...preamble, '[聚焦召回旧事]', '[客观相关旧事]', ...history.map((text,index) => `- AI #${index + 1}：${text}`), '[当前人物状态]', '- 裴晚生：愿意一起回钟楼。', '</qqj_recalled_context>'].join('\n'),
};
let recallState;
let renderer;
const view = () => document.querySelector('[data-qqj-inline-host]')?.__qqjInlineCard;
function expandAll(expanded) {
  const card = view();
  if (!card) return;
  if (card.expanded !== expanded) card.toggle.click();
  for (const group of card.root.querySelectorAll('details')) group.open = expanded;
}
async function render() {
  renderer?.destroy();
  const scenario = document.querySelector('#scenario').value;
  const receipt = scenario === 'storylines' ? storylineReceipt : scenario === 'legacy' ? legacyReceipt
    : { status:scenario === 'error' ? 'error' : 'empty', userMessageIndex, selectedFloors:[], selectedStates:[] };
  recallState = scenario === 'running'
    ? { activeRecall:{ chatId, userMessageIndex } }
    : scenario === 'missing' ? {}
    : { lastRecall:receipt, lastRecallBinding:{ chatId, userMessageIndex } };
  renderer = createInlineRenderer({
    memoryRuntime:{ getState:() => ({ chatId, floors }), extractFloor:async () => {} },
    recallRuntime:{ getState:() => recallState },
    hostAdapter:{ snapshot:() => ({ chat, chatId, context:{ chatMetadata:{ qianqianjie:{ chatId } } } }) },
  });
  renderer.start();
  await Promise.resolve();
  const card = view();
  if (card && !card.expanded) card.toggle.click();
}
document.querySelector('#scenario').addEventListener('change', () => render().catch(showError));
document.querySelector('#theme').addEventListener('change', event => document.documentElement.classList.toggle('light', event.target.value === 'light'));
document.querySelector('#width').addEventListener('change', event => document.querySelector('#stage').classList.toggle('mobile', event.target.value === 'mobile'));
document.querySelector('#expand').addEventListener('click', () => expandAll(true));
document.querySelector('#collapse').addEventListener('click', () => expandAll(false));
function showError(error) { document.querySelector('#error').textContent = `预览加载失败：${error.message}`; }
await render().catch(showError);
