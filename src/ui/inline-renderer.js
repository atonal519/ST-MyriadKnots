import { projectHistoricalRecallReceipt, RECALL_RECEIPT_KEY } from '../v3/recall-runtime.js';
import { inspectMessageFloorAnchor } from '../v3/message-floor-anchor.js';
import { MIGRATION_ALIAS_KEY } from '../v3/migration-prefix.js';
import { isMemoryExcludedMessage } from '../v3/memory-exclusion.js';
import { classifyInlineMessage, projectInlineMemoryFloor, projectInlineRecallReceipt } from './inline-projection.js';
import { publicErrorMessage } from '../public-error.js';

import { patchRecallTabs } from './recall-tabs.js';
import { scaleCssFontSizes } from './font-scale.js';

const RETRY_DELAYS = Object.freeze([0, 80, 180, 320, 500, 850, 1300, 2000, 3000, 4200]);
const HOST_SELECTOR = '[data-qqj-inline-host="true"]';
const OBSERVED_ATTRIBUTES = Object.freeze(['mesid', 'data-mesid', 'data-message-id', 'class', 'is_user']);
const INLINE_STYLE = `
:host{display:block;max-width:100%;box-sizing:border-box;color:inherit;font:inherit;background:transparent;text-shadow:none;--qqj-inline-knot:#a8322f;--qqj-inline-line:color-mix(in srgb,currentColor 18%,transparent)}
*,*::before,*::after{box-sizing:border-box}.card{position:relative;margin:8px 0 2px;padding:1px 5px 2px 10px;max-width:100%;color:inherit;background:transparent;border:1px solid var(--qqj-inline-line);border-left:2px solid var(--qqj-inline-knot);border-radius:8px}
.head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px;min-height:35px}.mark{position:absolute;left:0;top:18px;width:0;height:0;z-index:1;color:var(--qqj-inline-knot);pointer-events:none}.knot{position:absolute;left:-5px;top:-5px;width:9px;height:9px;border:1.5px solid currentColor;transform:rotate(45deg);border-radius:1px;background:transparent}.knot::after{content:"";position:absolute;inset:2px;background:currentColor;border-radius:1px}
.toggle,.extract,.exclude{font:inherit;color:inherit;background:none;border:0;box-shadow:none;border-radius:7px;min-height:32px;cursor:pointer}.toggle{min-width:0;text-align:left;padding:2px 3px;display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);align-items:center;gap:6px}.actions{display:flex;align-items:center;gap:1px}.title{min-width:0;font-size:12px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status{justify-self:start;min-width:0;max-width:100%;padding:1px 6px;border-radius:999px;font-size:10.5px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:color-mix(in srgb,currentColor 9%,transparent);color:inherit}.status.ready{background:color-mix(in srgb,#56a875 18%,transparent)}.status.running{background:color-mix(in srgb,#4c9bd1 18%,transparent)}.status.review{background:color-mix(in srgb,#d79a35 19%,transparent)}.status.error{background:color-mix(in srgb,#c84a46 17%,transparent)}
.extract,.exclude{width:32px;height:32px;padding:0;display:grid;place-items:center}.extract[hidden],.exclude[hidden]{display:none}.extract:disabled,.exclude:disabled{cursor:default;opacity:.42}.exclude[aria-pressed="true"]{background:color-mix(in srgb,var(--qqj-inline-knot) 14%,transparent);color:var(--qqj-inline-knot)}.icon{display:block;width:16px;height:16px;flex:none}.toggle:focus-visible,.extract:focus-visible,.exclude:focus-visible{outline:2px solid var(--qqj-inline-knot);outline-offset:1px}
.body{padding:4px 6px 9px 3px;font-size:13px;line-height:1.75;overflow-wrap:anywhere}.body[hidden],.facts[hidden],.summary[hidden]{display:none}.facts{display:grid;gap:0;margin:0;font-size:11px;line-height:1.5;opacity:.68}.meta-row{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.summary{margin:10px 0 0;font-size:13px;line-height:1.75;white-space:pre-wrap}.assistant .summary{padding-top:10px;border-top:1px solid var(--qqj-inline-line)}.body > .error{margin:7px 0 0;color:#a8322f;font-size:11px;line-height:1.55;white-space:pre-wrap}
@media(max-width:360px){.card{padding-left:8px}.head{grid-template-columns:minmax(0,1fr) auto;gap:2px}.toggle{gap:4px;padding-inline:2px}.actions{gap:0}.extract,.exclude{width:28px;height:30px}.body{padding-left:2px}.title{font-size:11.5px}.status{font-size:10px}}
@media(prefers-reduced-motion:reduce){.toggle,.extract,.exclude{scroll-behavior:auto}}
`;

const validIndex = value => Number.isSafeInteger(value) && value >= 0;
const digits = value => /^\d+$/u.test(String(value ?? '').trim()) ? Number(String(value).trim()) : null;
const setText = (node, value) => { const next = String(value ?? ''); if (node.textContent !== next) node.textContent = next; };
const remove = node => { try { node?.remove?.(); } catch { /* detached host */ } };
const receiptStamp = receipt => { try { return JSON.stringify(receipt); } catch { return ''; } };
const paletteColor = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const setStyleProperty = (style, name, value) => { if (typeof style?.setProperty === 'function') style.setProperty(name, value); else if (style) style[name] = value; };

export function resolveInlineMessageIndex(element) {
  for (const value of [
    element?.getAttribute?.('mesid'), element?.getAttribute?.('data-mesid'), element?.getAttribute?.('data-message-id'),
    element?.dataset?.mesid, element?.dataset?.messageId,
  ]) {
    const result = digits(value);
    if (result !== null && Number.isSafeInteger(result)) return result;
  }
  return null;
}

export function resolveInlineAnchor(messageElement) {
  return messageElement?.querySelector?.('.mes_text') ?? null;
}

function elementPriority(element, role) {
  const anchor = resolveInlineAnchor(element);
  let score = anchor && anchor !== element ? 3 : 0;
  if (element?.querySelector?.('.mes_text')) score += 1;
  if (element?.classList?.contains?.('last_mes') || String(element?.className ?? '').split(/\s+/u).includes('last_mes')) score += 2;
  const markedUser = element?.getAttribute?.('is_user') === 'true'
    || element?.classList?.contains?.('is_user') || element?.classList?.contains?.('user_mes');
  if ((role === 'user') === markedUser) score += 1;
  return score;
}

function append(parent, ...children) { parent?.append?.(...children); return parent; }

function createIcon(documentRef, kind) {
  const svg = documentRef.createElementNS?.('http://www.w3.org/2000/svg', 'svg') ?? documentRef.createElement('svg');
  svg.setAttribute?.('viewBox', '0 0 24 24'); svg.setAttribute?.('width', '16'); svg.setAttribute?.('height', '16');
  svg.setAttribute?.('class', 'icon'); svg.setAttribute?.('aria-hidden', 'true');
  const group = documentRef.createElementNS?.('http://www.w3.org/2000/svg', 'g') ?? documentRef.createElement('g');
  group.setAttribute?.('fill', 'none'); group.setAttribute?.('stroke', 'currentColor'); group.setAttribute?.('stroke-linecap', 'round'); group.setAttribute?.('stroke-width', '1.5');
  const shapes = kind === 'ghost'
    ? [['path', 'M22 12.3006C22 6.61173 17.5228 2 12 2C6.47715 2 2 6.61173 2 12.3006V19.723C2 21.0453 3.35098 21.9054 4.4992 21.314C5.42726 20.836 6.5328 20.9069 7.39614 21.4998C8.36736 22.1667 9.63264 22.1667 10.6039 21.4998L10.9565 21.2576C11.5884 20.8237 12.4116 20.8237 13.0435 21.2576L13.3961 21.4998C14.3674 22.1667 15.6326 22.1667 16.6039 21.4998C17.4672 20.9069 18.5727 20.836 19.5008 21.314C20.649 21.9054 22 21.0453 22 19.723V16.0118'], ['path', 'M15.5 10.5C15.5 11.0523 15.2761 11.5 15 11.5C14.7239 11.5 14.5 11.0523 14.5 10.5C14.5 9.94772 14.7239 9.5 15 9.5C15.2761 9.5 15.5 9.94772 15.5 10.5Z'], ['ellipse', null, { cx: '9', cy: '10.5', rx: '.5', ry: '1' }]]
    : [['path', 'M15 12L12 12M12 12L9 12M12 12L12 9M12 12L12 15'], ['path', 'M7 3.33782C8.47087 2.48697 10.1786 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 10.1786 2.48697 8.47087 3.33782 7']];
  for (const [tag, data, attributes = {}] of shapes) {
    const node = documentRef.createElementNS?.('http://www.w3.org/2000/svg', tag) ?? documentRef.createElement(tag);
    if (data) node.setAttribute?.('d', data);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute?.(name, value);
    group.append?.(node);
  }
  svg.append?.(group);
  return svg;
}

function createCard(documentRef, host, kind, expanded, onToggle, onExtract, onExclude) {
  const root = host.attachShadow({ mode: 'open' });
  const style = documentRef.createElement('style'); style.textContent = scaleCssFontSizes(INLINE_STYLE, '--qqj-inline-fixed-scale');
  const card = documentRef.createElement('article'); card.className = `card ${kind}`;
  const head = documentRef.createElement('div'); head.className = 'head';
  const mark = documentRef.createElement('span'); mark.className = 'mark'; mark.setAttribute?.('aria-hidden', 'true');
  const knot = documentRef.createElement('span'); knot.className = 'knot'; mark.append(knot);
  const toggle = documentRef.createElement('button'); toggle.type = 'button'; toggle.className = 'toggle';
  const title = documentRef.createElement('span'); title.className = 'title';
  const status = documentRef.createElement('span'); status.className = 'status';
  append(toggle, title, status);
  const actions = documentRef.createElement('div'); actions.className = 'actions';
  const extract = documentRef.createElement('button'); extract.type = 'button'; extract.className = 'extract'; extract.title = '重新提取本楼摘要；已人工处理的千事记录保留'; extract.setAttribute?.('aria-label', '重新提取本楼摘要；已人工处理的千事记录保留'); append(extract, createIcon(documentRef, 'extract'));
  const exclude = documentRef.createElement('button'); exclude.type = 'button'; exclude.className = 'exclude'; append(exclude, createIcon(documentRef, 'ghost'));
  append(actions, extract, exclude);
  const body = documentRef.createElement('div'); body.className = 'body';
  const facts = documentRef.createElement('div'); facts.className = 'facts';
  const time = documentRef.createElement('div'), locations = documentRef.createElement('div'), people = documentRef.createElement('div');
  time.className = 'meta-row time'; locations.className = 'meta-row locations'; people.className = 'meta-row people'; append(facts, time, locations, people);
  const fields = { time, locations, people };
  const summary = documentRef.createElement('p'); summary.className = 'summary';
  const error = documentRef.createElement('p'); error.className = 'error';
  append(body, facts, summary, error); append(head, toggle, actions); append(card, mark, head, body); append(root, style, card);
  const view = { host, root, card, mark, knot, toggle, title, status, extract, exclude, actions, body, facts, fields, summary, error, kind, expanded, signature: '', projection: null, extracting: false, excluding: false };
  toggle.addEventListener('click', () => onToggle(view));
  extract.addEventListener('click', () => onExtract(view));
  exclude.addEventListener('click', () => onExclude(view));
  host.__qqjInlineCard = view;
  return view;
}

function patchExpanded(view) {
  view.body.hidden = !view.expanded;
  view.host.setAttribute?.('data-open', String(view.expanded));
  view.toggle.setAttribute?.('aria-expanded', String(view.expanded));
  view.toggle.setAttribute?.('aria-label', `${view.expanded ? '折叠' : '展开'}${view.labelTitle ?? (view.kind === 'user' ? '本轮召回' : '本楼记忆')}`);
}

function createSourceIndex(chat, chatId, state) {
  const markerIndices = new Map(), duplicateMarkerFloorIds = new Set();
  for (let messageIndex = 0; messageIndex < chat.length; messageIndex += 1) {
    if (classifyInlineMessage(chat[messageIndex]) !== 'assistant') continue;
    const inspected = inspectMessageFloorAnchor(chat[messageIndex], chatId);
    if (inspected.status !== 'valid') continue;
    const floorId = inspected.anchor.floorId;
    if (markerIndices.has(floorId)) {
      markerIndices.delete(floorId);
      duplicateMarkerFloorIds.add(floorId);
    } else if (!duplicateMarkerFloorIds.has(floorId)) markerIndices.set(floorId, messageIndex);
  }
  const stateChatId = String(state?.chatId ?? '').trim();
  const memoryMatchesChat = !stateChatId || Boolean(chatId && stateChatId === chatId);
  const memoryIndices = new Map(), duplicateMemoryFloorIds = new Set(), frozenOrigins = new Map();
  if (memoryMatchesChat) for (const floor of state?.floors ?? []) {
    const floorId = typeof floor?.floorId === 'string' ? floor.floorId.trim() : '';
    if (!floorId || !validIndex(floor.messageIndex)) continue;
    if (memoryIndices.has(floorId)) {
      memoryIndices.delete(floorId);
      duplicateMemoryFloorIds.add(floorId);
    } else if (!duplicateMemoryFloorIds.has(floorId)) memoryIndices.set(floorId, floor.messageIndex);
    if (floor.frozen === true && validIndex(floor.sourceOrigin?.sourceMessageIndex)) {
      frozenOrigins.set(floorId, Object.freeze({
        sourceMessageIndex: floor.sourceOrigin.sourceMessageIndex,
        ...(typeof floor.sourceOrigin.sourceChatId === 'string' ? { sourceChatId: floor.sourceOrigin.sourceChatId } : {}),
        ...(typeof floor.sourceOrigin.sourceHostChatId === 'string' ? { sourceHostChatId: floor.sourceOrigin.sourceHostChatId } : {}),
      }));
    }
  }
  return Object.freeze({
    messageIndexFor(floorId) {
      if (!floorId || duplicateMarkerFloorIds.has(floorId)) return null;
      if (markerIndices.has(floorId)) return markerIndices.get(floorId);
      return duplicateMemoryFloorIds.has(floorId) ? null : (memoryIndices.get(floorId) ?? null);
    },
    sourceFor(floorId) {
      const sourceOrigin = duplicateMemoryFloorIds.has(floorId) ? null : (frozenOrigins.get(floorId) ?? null);
      return sourceOrigin ? Object.freeze({ frozen: true, sourceOrigin }) : null;
    },
  });
}

function statusTone(projection) {
  if (projection.kind === 'user') return '';
  if (['error', 'failed'].includes(projection.status)) return 'error';
  if (projection.status === 'running') return 'running';
  if (projection.status === 'ready') return 'ready';
  return '';
}

function patchView(view, projection, documentRef, sourceIndex, groupExpanded) {
  if (projection.kind === 'user') {
    view.projection = projection;
    view.labelTitle = '千千结 · 本轮召回'; setText(view.title, view.labelTitle); view.title.title = view.labelTitle;
    setText(view.status, projection.statusText); view.status.className = 'status';
    view.status.title = projection.statusDetail ?? '';
    view.status.setAttribute?.('aria-label', projection.statusDetail ? `${projection.statusText}：${projection.statusDetail}` : projection.statusText);
    view.extract.hidden = true; view.extract.disabled = true; view.exclude.hidden = true; view.exclude.disabled = true;
    patchRecallTabs(view, projection, documentRef, sourceIndex, groupExpanded);
    patchExpanded(view); return;
  }
  const signature = JSON.stringify(projection);
  if (view.signature === signature) {
    view.extract.hidden = projection.readOnly === true; view.extract.disabled = view.extracting || !projection.canExtract;
    view.facts.hidden = projection.memoryExcluded === true;
    view.summary.hidden = projection.memoryExcluded === true;
    view.exclude.hidden = projection.readOnly === true;
    view.exclude.disabled = view.excluding || projection.busy === true;
    view.exclude.setAttribute?.('aria-pressed', String(projection.memoryExcluded === true));
    view.exclude.title = projection.memoryExcluded === true ? '恢复记录，需补记本楼' : '本楼不计入记忆';
    view.exclude.setAttribute?.('aria-label', view.exclude.title);
    patchExpanded(view); return;
  }
  view.signature = signature; view.projection = projection;
  const title = projection.kind === 'user' ? '千千结 · 本轮召回' : validIndex(projection.messageIndex) ? `第 ${projection.messageIndex} 个结` : '本楼记忆';
  view.labelTitle = title; setText(view.title, title); view.title.title = title;
  setText(view.status, projection.statusText); view.status.className = `status${statusTone(projection) ? ` ${statusTone(projection)}` : ''}`;
  if (projection.kind === 'assistant') {
    view.facts.hidden = projection.memoryExcluded === true;
    view.summary.hidden = projection.memoryExcluded === true;
    setText(view.fields.time, `时间 ${projection.time}`); setText(view.fields.locations, `地点 ${projection.locations}`); setText(view.fields.people, `人物 ${projection.people}`);
    setText(view.summary, projection.summary); const errorText = projection.error || view.exclusionFeedback || ''; setText(view.error, errorText); view.error.hidden = !errorText;
    const extractLabel = `重新提取${title}摘要；已人工处理的千事记录保留`; view.extract.title = extractLabel; view.extract.setAttribute?.('aria-label', extractLabel);
    view.extract.hidden = projection.readOnly === true; view.extract.disabled = view.extracting || !projection.canExtract;
    view.exclude.hidden = projection.readOnly === true;
    view.exclude.disabled = view.excluding || projection.busy === true;
    view.exclude.setAttribute?.('aria-pressed', String(projection.memoryExcluded === true));
    view.exclude.title = projection.memoryExcluded === true ? '恢复记录，需补记本楼' : '本楼不计入记忆';
    view.exclude.setAttribute?.('aria-label', view.exclude.title);
  }
  patchExpanded(view);
}

export function createInlineRenderer({
  memoryRuntime, recallRuntime, hostAdapter,
  documentRef = globalThis.document, windowRef = documentRef?.defaultView ?? globalThis,
  projectReceipt = projectHistoricalRecallReceipt, logger = console,
} = {}) {
  if (!memoryRuntime || typeof memoryRuntime.getState !== 'function' || typeof memoryRuntime.extractFloor !== 'function') throw new TypeError('楼内渲染 memory runtime 无效');
  if (!recallRuntime || typeof recallRuntime.getState !== 'function') throw new TypeError('楼内渲染 recall runtime 无效');
  if (!hostAdapter || typeof hostAdapter.snapshot !== 'function') throw new TypeError('楼内渲染 host adapter 无效');
  let active = false, destroyed = false, session = 0, attempt = 0, retryIndex = 0, activeChatKey = null, observer = null, timer = null, queued = false;
  const cards = new Map(), expanded = new Map(), groupExpanded = new Map(), expectedIndices = new Set(), eventBindings = [];
  let unsubscribeMemory = null, unsubscribeRecall = null;
  let showRecall = true, showMemory = true;
  const visibleRole = role => role === 'user' ? showRecall : role === 'assistant' && showMemory;
  let palette = Object.freeze({ knot: '#a8322f', line: 'color-mix(in srgb,currentColor 18%,transparent)' });
  let fontScale = 1;
  const receiptCache = new WeakMap();
  const owner = {};
  let historicalBatch = null;
  const clearHistoricalPending = batch => {
    for (const item of batch) if (item.view.receiptPending === item.pendingReceipt) item.view.receiptPending = null;
  };

  const applyPalette = host => {
    setStyleProperty(host?.style, '--qqj-inline-knot', palette.knot);
    setStyleProperty(host?.style, '--qqj-inline-line', palette.line);
    setStyleProperty(host?.style, '--qqj-inline-fixed-scale', String(fontScale));
  };

  const clearRetry = () => { if (timer !== null) { windowRef?.clearTimeout?.(timer); timer = null; } observer?.disconnect?.(); observer = null; attempt += 1; };
  const removeAll = () => { for (const view of cards.values()) remove(view.host); cards.clear(); for (const host of documentRef?.querySelectorAll?.(HOST_SELECTOR) ?? []) remove(host); };
  const resetSession = () => { session += 1; clearRetry(); expectedIndices.clear(); activeChatKey = null; removeAll(); };

  const cardKey = (chatKey, messageIndex, kind) => `${chatKey}:${messageIndex}:${kind}`;
  const onToggle = view => {
    view.expanded = !view.expanded;
    expanded.set(view.stateKey, view.expanded);
    patchExpanded(view);
  };
  const onExtract = view => {
    const projection = view.projection;
    if (!active || view.extracting || projection?.kind !== 'assistant' || !projection.canExtract || !projection.floorId) return;
    view.extracting = true; view.extract.disabled = true;
    Promise.resolve(memoryRuntime.extractFloor(projection.floorId)).catch(error => {
      logger?.warn?.('[qianqianjie] 楼内重新提取失败', { code: String(error?.code ?? error?.name ?? 'V3_INLINE_EXTRACT_FAILED').slice(0, 120) });
    }).finally(() => { view.extracting = false; schedule(); });
  };
  const onExclude = view => {
    const projection = view.projection;
    if (!active || view.excluding || projection?.kind !== 'assistant' || projection.readOnly === true || projection.busy === true) return;
    view.excluding = true; view.exclude.disabled = true; view.exclusionFeedback = '';
    Promise.resolve(memoryRuntime.setMemoryExcluded?.(view.messageIndex, projection.memoryExcluded !== true)).then(result => {
      if (!['persisted', 'unchanged'].includes(result?.status)) {
        view.exclusionFeedback = String(result?.message ?? '当前不能更改这楼的记忆状态。').slice(0, 240);
        view.expanded = true; expanded.set(view.stateKey, true);
        setText(view.error, view.exclusionFeedback); view.error.hidden = false; patchExpanded(view);
        return;
      }
      view.exclusionFeedback = '';
      setText(view.error, ''); view.error.hidden = true;
      if (result.status === 'persisted') schedule();
    }).catch(error => {
      view.exclusionFeedback = publicErrorMessage(error, { fallback: '消息标记保存失败，请稍后重试。' });
      view.expanded = true; expanded.set(view.stateKey, true);
      setText(view.error, view.exclusionFeedback); view.error.hidden = false; patchExpanded(view);
    }).finally(() => { view.excluding = false; schedule(); });
  };

  const ensureView = (messageElement, messageIndex, kind, chatKey) => {
    const anchor = resolveInlineAnchor(messageElement);
    if (!anchor?.append) return null;
    let view = cards.get(messageIndex);
    if (view && (view.kind !== kind || view.host?.parentElement !== anchor || view.host?.isConnected === false)) {
      remove(view.host); cards.delete(messageIndex); view = null;
    }
    if (!view) {
      let host = [...(anchor.querySelectorAll?.(HOST_SELECTOR) ?? [])].find(value => resolveInlineMessageIndex(value) === messageIndex) ?? null;
      if (host && host.__qqjInlineOwner !== owner) { remove(host); host = null; }
      if (!host) {
        host = documentRef.createElement('div');
        host.className = 'qqj-inline-host'; host.setAttribute?.('data-qqj-inline-host', 'true'); host.setAttribute?.('data-message-id', String(messageIndex));
        if (host.dataset) { host.dataset.qqjInlineHost = 'true'; host.dataset.messageId = String(messageIndex); }
        anchor.append(host);
      }
      host.__qqjInlineOwner = owner;
      applyPalette(host);
      const stateKey = cardKey(chatKey, messageIndex, kind);
      view = host.__qqjInlineCard ?? createCard(documentRef, host, kind, expanded.get(stateKey) === true, onToggle, onExtract, onExclude);
      view.stateKey = stateKey; view.kind = kind; cards.set(messageIndex, view);
    }
    view.messageIndex = messageIndex;
    return view;
  };

  const liveRecallFor = (state, chatId, messageIndex) => {
    if (state?.activeRecall?.chatId === chatId && state.activeRecall.userMessageIndex === messageIndex) {
      const phase = state.activeRecall.phase;
      // 冻结复用的来源核验只核对既有回执，不代表重新选材。
      const verifyingExisting = state.activeRecall.pendingStep === 'receiptSourceVerification';
      const preparing = phase === 'input' || phase === 'source', selecting = phase === 'selecting';
      return Object.freeze({ status: 'running', statusText: verifyingExisting ? '核验已有召回' : preparing ? '准备召回中' : selecting ? '召回中' : '寻回中',
        summary: verifyingExisting ? '正在核验已有召回的来源；通过后复用已存回执。' : preparing ? '正在准备本轮召回。' : selecting ? '正在生成本轮召回。' : '正在生成本轮召回回执。',
        statusDetail: verifyingExisting ? '正在核验已有召回的来源；通过后复用已存回执。' : null,
        injectionText: '', selectedFloors: Object.freeze([]), historyGroups: Object.freeze([]), kind: 'user' });
    }
    if (state?.lastRecallBinding?.chatId === chatId && state.lastRecallBinding.userMessageIndex === messageIndex
      && state?.lastRecall?.userMessageIndex === messageIndex) return projectInlineRecallReceipt(state.lastRecall);
    return null;
  };

  const historicalProjection = (message, chatId, messageIndex, stamp) => {
    const receipt = message.extra?.[RECALL_RECEIPT_KEY];
    if (!receipt || typeof receipt !== 'object') return Promise.resolve(null);
    const cached = receiptCache.get(receipt);
    if (cached && cached.chatId === chatId && cached.messageIndex === messageIndex && cached.messageText === message.mes && cached.stamp === stamp) return cached.promise;
    const promise = Promise.resolve(projectReceipt(message, { chatId, userMessageIndex: messageIndex })).catch(() => null);
    receiptCache.set(receipt, { chatId, messageIndex, messageText: message.mes, stamp, promise });
    return promise;
  };

  // 同一微任务里完成的旧回执共用flush时的新快照与来源索引，避免逐楼重读并防止沿用等待前的位置。
  const flushHistoricalBatch = batch => {
    if (historicalBatch === batch) historicalBatch = null;
    if (!batch.length) return;
    if (!active || destroyed) { clearHistoricalPending(batch); return; }
    const validBatch = [];
    for (const item of batch) {
      const { message, messageIndex, messageText, receipt, stamp, view, pendingReceipt } = item;
      if (message.mes === messageText && message.extra?.[RECALL_RECEIPT_KEY] === receipt && receiptStamp(receipt) === stamp
        && cards.get(messageIndex) === view && view.host?.isConnected !== false && view.receiptPending === pendingReceipt) validBatch.push(item);
      else if (view.receiptPending === pendingReceipt) view.receiptPending = null;
    }
    if (!validBatch.length) return;
    let memoryState, recallState;
    try { memoryState = memoryRuntime.getState(); recallState = recallRuntime.getState(); }
    catch { clearHistoricalPending(validBatch); return; }
    const sourceIndexes = new Map();
    for (const item of validBatch) {
      const { result, messageIndex, messageText, receipt, stamp, chatId, sourceChat, view, pendingReceipt } = item;
      if (view.receiptPending !== pendingReceipt) continue;
      view.receiptPending = null;
      const settledProjection = result ? projectInlineRecallReceipt(result) : projectInlineRecallReceipt(null);
      view.receiptIdentity = receipt; view.receiptMessageText = messageText; view.receiptStamp = stamp; view.receiptChatId = chatId;
      // A live projection may temporarily replace the visible card; keep the verified historical receipt as its own view cache.
      view.receiptProjection = settledProjection; view.receiptSettled = true;
      const latestLive = liveRecallFor(recallState, chatId, messageIndex);
      const projection = latestLive ?? settledProjection;
      let byChatId = sourceIndexes.get(sourceChat);
      if (!byChatId) { byChatId = new Map(); sourceIndexes.set(sourceChat, byChatId); }
      let sourceIndex = byChatId.get(chatId);
      // sourceChat 是开始核验时的宿主数组引用；用其flush时的现行marker对应原回执目标。
      if (!sourceIndex) { sourceIndex = createSourceIndex(sourceChat, chatId, memoryState); byChatId.set(chatId, sourceIndex); }
      patchView(view, projection, documentRef, sourceIndex, groupExpanded);
    }
  };

  const queueHistoricalResult = item => {
    if (!historicalBatch) {
      const batch = [];
      historicalBatch = batch;
      Promise.resolve().then(() => flushHistoricalBatch(batch));
    }
    historicalBatch.push(item);
  };

  const updateUser = (view, message, messageIndex, chatId, sourceIndex, recallState, sourceChat) => {
    const live = liveRecallFor(recallState, chatId, messageIndex);
    const receipt = message.extra?.[RECALL_RECEIPT_KEY];
    if (!receipt || typeof receipt !== 'object') {
      view.receiptIdentity = null; view.receiptMessageText = null; view.receiptStamp = null; view.receiptChatId = null;
      view.receiptProjection = null; view.receiptSettled = false;
      patchView(view, live ?? projectInlineRecallReceipt(null), documentRef, sourceIndex, groupExpanded); return;
    }
    const messageText = message.mes, stamp = receiptStamp(receipt);
    const hasSameReceiptIdentity = view.receiptIdentity === receipt && view.receiptMessageText === messageText && view.receiptStamp === stamp && view.receiptChatId === chatId;
    if (!hasSameReceiptIdentity) {
      view.receiptIdentity = null; view.receiptMessageText = null; view.receiptStamp = null; view.receiptChatId = null;
      view.receiptProjection = null; view.receiptSettled = false;
    }
    const sameSettledReceipt = view.receiptIdentity === receipt && view.receiptMessageText === messageText && view.receiptStamp === stamp && view.receiptChatId === chatId && view.receiptSettled === true;
    const samePendingReceipt = view.receiptPending?.receipt === receipt && view.receiptPending.messageText === messageText && view.receiptPending.stamp === stamp && view.receiptPending.chatId === chatId;
    if (live) patchView(view, live, documentRef, sourceIndex, groupExpanded);
    else if (sameSettledReceipt) { patchView(view, view.receiptProjection, documentRef, sourceIndex, groupExpanded); return; }
    else patchView(view, Object.freeze({ status: 'running', statusText: '正在核验历史回执', summary: '正在核验这一楼保存的召回记录。', injectionText: '', selectedFloors: Object.freeze([]), historyGroups: Object.freeze([]), kind: 'user' }), documentRef, sourceIndex, groupExpanded);
    if (samePendingReceipt) return;
    const pendingReceipt = { receipt, messageText, stamp, chatId };
    view.receiptPending = pendingReceipt;
    void historicalProjection(message, chatId, messageIndex, stamp).then(result => {
      if (!active || destroyed || message.mes !== messageText || message.extra?.[RECALL_RECEIPT_KEY] !== receipt || receiptStamp(receipt) !== stamp
        || cards.get(messageIndex) !== view || view.host?.isConnected === false) {
        if (view.receiptPending === pendingReceipt) view.receiptPending = null;
        return;
      }
      if (view.receiptPending !== pendingReceipt) return;
      queueHistoricalResult({ result, message, messageIndex, messageText, receipt, stamp, chatId, sourceChat, view, pendingReceipt });
    });
  };

  const refresh = () => {
    if (!active || destroyed || !documentRef?.querySelector) return true;
    if (!showRecall && !showMemory) { removeAll(); expectedIndices.clear(); return true; }
    let snapshot;
    try { snapshot = hostAdapter.snapshot(); } catch { return false; }
    const chat = Array.isArray(snapshot?.chat) ? snapshot.chat : [];
    const chatId = String(snapshot?.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim();
    const chatKey = `${chatId || snapshot?.chatId || 'no-chat'}|${snapshot?.chatId || ''}`;
    if (activeChatKey !== chatKey) {
      session += 1;
      if (timer !== null) { windowRef?.clearTimeout?.(timer); timer = null; }
      observer?.disconnect?.(); observer = null;
      expectedIndices.clear(); removeAll(); activeChatKey = chatKey;
    }
    const chatRoot = documentRef.querySelector('#chat');
    if (!chatRoot?.querySelectorAll) return false;
    const chosen = new Map();
    for (const element of chatRoot.querySelectorAll('.mes')) {
      const messageIndex = resolveInlineMessageIndex(element);
      const message = validIndex(messageIndex) ? chat[messageIndex] : null;
      const role = classifyInlineMessage(message);
      if (!visibleRole(role)) continue;
      const previous = chosen.get(messageIndex);
      if (!previous || elementPriority(element, role) >= previous.priority) chosen.set(messageIndex, { element, role, priority: elementPriority(element, role) });
    }
    const memoryState = memoryRuntime.getState(), recallState = recallRuntime.getState();
    const sourceIndex = createSourceIndex(chat, chatId, memoryState);
    const assistantSequence = new Map(); let assistantSeq = 0;
    for (let index = 0; index < chat.length; index += 1) if (classifyInlineMessage(chat[index]) === 'assistant') assistantSequence.set(index, ++assistantSeq);
    let complete = true;
    for (const [messageIndex, candidate] of chosen) {
      const view = ensureView(candidate.element, messageIndex, candidate.role, chatKey);
      if (!view) { complete = false; continue; }
      if (candidate.role === 'assistant') patchView(view, projectInlineMemoryFloor(memoryState, messageIndex, assistantSequence.get(messageIndex), {
        migrationAliasId: chat[messageIndex]?.extra?.[MIGRATION_ALIAS_KEY] ?? null,
        memoryExcluded: isMemoryExcludedMessage(chat[messageIndex]),
      }), documentRef, sourceIndex, groupExpanded);
      else updateUser(view, chat[messageIndex], messageIndex, chatId, sourceIndex, recallState, chat);
    }
    for (const [messageIndex, view] of [...cards]) if (!chosen.has(messageIndex)) { remove(view.host); cards.delete(messageIndex); }
    for (const host of documentRef.querySelectorAll(HOST_SELECTOR)) {
      const index = resolveInlineMessageIndex(host);
      if (!validIndex(index) || cards.get(index)?.host !== host) remove(host);
    }
    const renderableCount = chat.reduce((count, message) => count + (visibleRole(classifyInlineMessage(message)) ? 1 : 0), 0);
    if (renderableCount > 0 && chosen.size === 0) complete = false;
    for (const messageIndex of expectedIndices) if (visibleRole(classifyInlineMessage(chat[messageIndex])) && !chosen.has(messageIndex)) complete = false;
    if (complete) expectedIndices.clear();
    return complete;
  };

  const runAttempts = mine => {
    if (!active || destroyed || mine !== attempt) return;
    observer?.disconnect?.(); observer = null;
    if (refresh()) return;
    if (retryIndex >= RETRY_DELAYS.length) return;
    const Observer = windowRef?.MutationObserver ?? globalThis.MutationObserver;
    const root = documentRef?.querySelector?.('#chat') ?? documentRef?.body;
    if (typeof Observer === 'function' && root) {
      observer = new Observer(() => { observer?.disconnect?.(); observer = null; if (timer !== null) { windowRef?.clearTimeout?.(timer); timer = null; } runAttempts(mine); });
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: [...OBSERVED_ATTRIBUTES] });
    }
    const delayIndex = retryIndex;
    retryIndex += 1;
    timer = windowRef?.setTimeout?.(() => { timer = null; runAttempts(mine); }, RETRY_DELAYS[delayIndex]) ?? null;
  };

  function schedule(...args) {
    if (!active || destroyed) return;
    for (const arg of args) {
      const direct = digits(arg);
      if (direct !== null && validIndex(direct)) expectedIndices.add(direct);
      else if (arg && typeof arg === 'object') for (const key of ['messageIndex', 'messageId', 'mesid']) {
        if (!Object.hasOwn(arg, key)) continue;
        const nested = digits(arg[key]); if (nested !== null && validIndex(nested)) expectedIndices.add(nested);
      }
    }
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => {
      queued = false; if (!active || destroyed) return;
      clearRetry(); retryIndex = 0; const mine = attempt; runAttempts(mine);
    });
  }

  const bindEvents = () => {
    let snapshot; try { snapshot = hostAdapter.snapshot(); } catch { return; }
    const source = snapshot?.eventSource, types = snapshot?.eventTypes ?? {};
    if (!source?.on) return;
    for (const name of ['CHAT_CHANGED', 'CHAT_RENAMED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MORE_MESSAGES_LOADED', 'GENERATION_ENDED']) {
      const event = types[name]; if (!event) continue;
      const handler = (...args) => { if (name === 'CHAT_CHANGED' || name === 'CHAT_RENAMED') resetSession(); schedule(...args); };
      source.on(event, handler); eventBindings.push({ source, event, handler });
    }
  };

  function start() {
    if (destroyed || active) return { status: destroyed ? 'destroyed' : 'ready' };
    active = true; bindEvents();
    unsubscribeMemory = memoryRuntime.subscribe?.(() => schedule()) ?? null;
    unsubscribeRecall = recallRuntime.subscribe?.(() => schedule()) ?? null;
    schedule(); return { status: 'ready' };
  }
  function stop() {
    active = false; resetSession();
    unsubscribeMemory?.(); unsubscribeMemory = null; unsubscribeRecall?.(); unsubscribeRecall = null;
    for (const { source, event, handler } of eventBindings.splice(0)) {
      if (typeof source.removeListener === 'function') source.removeListener(event, handler);
      else source.off?.(event, handler);
    }
    return { status: 'stopped' };
  }
  function setEnabled(value) { return value === true ? start() : stop(); }
  function setVisibility({ recall = true, memory = true } = {}) {
    const nextRecall = recall !== false, nextMemory = memory !== false;
    if (nextRecall === showRecall && nextMemory === showMemory) return;
    showRecall = nextRecall; showMemory = nextMemory;
    // Visibility only changes mounted cards; extraction and recall subscriptions keep running.
    for (const [index, view] of cards) if (!visibleRole(view.kind)) { remove(view.host); cards.delete(index); }
    schedule();
  }
  function setAppearance(value) {
    fontScale = Number.isFinite(Number(value?.fixedScale)) ? Number(value.fixedScale) : 1;
    palette = Object.freeze({
      knot: paletteColor(value?.palette?.knot, '#a8322f'),
      line: paletteColor(value?.palette?.line, 'color-mix(in srgb,currentColor 18%,transparent)'),
    });
    for (const view of cards.values()) applyPalette(view.host);
    return palette;
  }
  function destroy() { stop(); destroyed = true; clearRetry(); removeAll(); expanded.clear(); groupExpanded.clear(); }

  return Object.freeze({ start, stop, setEnabled, setAppearance, setVisibility, destroy, schedule, refresh, getDebugState: () => Object.freeze({ active, destroyed, session, cards: cards.size, observing: Boolean(observer), retrying: timer !== null, eventBindings: eventBindings.length }) });
}
