import { formatRecallInjection } from '../src/v3/recall-selector.js';
import { renderedQianshiProgressText, RECALL_STRATEGY_VERSION } from '../src/v3/recall-runtime.js';
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
const extraHistory = [
  '书店老板把修缮账簿交给你们，要求看完后归还。',
  '你发现一张旧照片，钟楼侧门旁站着一个撑伞的人。',
  '裴晚生认出照片上的花纹，却没有说明它的来历。',
  '江离州在信封背面找到日期，与你记忆中的约定相隔一年。',
  '林照把散页按编号排好，缺少的那页记着冬至夜的来客。',
  '你在书页间找到一张车票，目的地是河对岸的小站。',
  '裴晚生说车票属于故人，仍请你暂时替他保管。',
  '临走前，老板提醒你们钟楼的灯将在九点熄灭。',
];
const previewFloors = [...history, ...extraHistory].map((text, index) => ({
  floorId: floors[index]?.floorId ?? `preview-reading-${index}`, assistantSeq: index + 1, messageIndex: 11 + index * 2,
  items: [{ category: 'narrative', kind: 'summary', text, storylineId: index >= 8 ? 'recent' : 'clocktower' }],
}));
previewFloors[0].items.push({ category: 'shared', kind: 'commitment', speakerEntityId: 'pei', targetEntityIds: ['jiang'], storylineId: 'clocktower',
  text: '历史承诺·当时已作出：答应在冬至夜带着旧钥匙回钟楼。' });
const sourceFloors = previewFloors.map(({ floorId, assistantSeq, messageIndex }) => ({ floorId, assistantSeq, messageIndex }));
const qianshiProgress = { projectionVersion: 5, fingerprint: 'sha256:preview-qianshi', eventIds: ['preview-event'], matterIds: ['preview-matter'],
  text: '本轮千事资料来源截至：AI #12。\n\n[相关时间线]\n- 冬至前夜：在旧书店取得修缮账簿。\n\n[相关跟进事项]\n- 归还修缮账簿；状态：待办；跟进：持续。' };
const previewPlaces = [{ kind: 'placeFoundation', placeEntityId: 'clocktower', text: '钟楼侧门通向河边小路', source: { kind: 'worldbook', locator: '示例场景:3' } }];
const reminder = { itemId: 'preview-time', text: '裴晚生 / 赴约：观察于冬至前夜；约定期限 冬至夜，还有1天。' };
const entityById = new Map([['pei', { displayName: '裴晚生' }], ['jiang', { displayName: '江离州' }], ['lin', { displayName: '林照' }]]);
function previewReceipt(onlyObjects = false, legacy = false) {
  const dependencies = { mode: 'selected', corrections: [], reminders: [] };
  const source = onlyObjects ? [] : previewFloors;
  const states = onlyObjects ? [] : selectedStates;
  const changes = onlyObjects ? [] : selectedCseChanges;
  const lines = onlyObjects || legacy ? [] : storylines;
  const ordinary = formatRecallInjection({ coverage: { memoryComplete: true, cseCurrent: true }, floors: source,
    states, cseChanges: changes, storylines: lines, entityById, manualPlaces: previewPlaces,
    timeProjection: { corrections: {} }, timeReminders: [reminder], timeDependencies: dependencies });
  return { schemaVersion: legacy ? 11 : 18, strategyVersion: RECALL_STRATEGY_VERSION, status: 'ready', userMessageIndex,
    createdAt: '2026-11-04T01:00:00.000Z', selectedFloors: source.map(({ floorId, assistantSeq }) => ({ floorId, assistantSeq })),
    selectedStates: states, selectedCseChanges: changes, storylines: lines, selectedPlaces: previewPlaces, timeDependencies: dependencies,
    ...(!legacy ? { qianshiProgress } : {}), injectionText: ordinary + (legacy ? '' : '\n\n<qqj_qianshi_progress>\n' + renderedQianshiProgressText(qianshiProgress, dependencies) + '\n</qqj_qianshi_progress>') };
}
const storylineReceipt = previewReceipt();
const legacyReceipt = previewReceipt(false, true);
const objectOnlyReceipt = previewReceipt(true);
let recallState;
let renderer;
const view = () => document.querySelector('[data-qqj-inline-host]')?.__qqjInlineCard;
function setExpanded(expanded) {
  const card = view();
  if (!card) return;
  if (card.expanded !== expanded) card.toggle.click();
}
async function render() {
  renderer?.destroy();
  const scenario = document.querySelector('#scenario').value;
  const receipt = scenario === 'storylines' ? storylineReceipt : scenario === 'legacy' ? legacyReceipt : scenario === 'objects' ? objectOnlyReceipt
    : { status:scenario === 'error' ? 'error' : 'empty', userMessageIndex, selectedFloors:[], selectedStates:[] };
  recallState = scenario === 'running'
    ? { activeRecall:{ chatId, userMessageIndex } }
    : scenario === 'missing' ? {}
    : { lastRecall:receipt, lastRecallBinding:{ chatId, userMessageIndex } };
  renderer = createInlineRenderer({
    memoryRuntime:{ getState:() => ({ chatId, floors: sourceFloors }), extractFloor:async () => {} },
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
document.querySelector('#expand').addEventListener('click', () => setExpanded(true));
document.querySelector('#collapse').addEventListener('click', () => setExpanded(false));
function showError(error) { document.querySelector('#error').textContent = `预览加载失败：${error.message}`; }
await render().catch(showError);
