import { projectHistoricalRecallReceipt, RECALL_RECEIPT_KEY } from '../v3/recall-runtime.js';
import { inspectMessageFloorAnchor } from '../v3/message-floor-anchor.js';
import { classifyInlineMessage, projectInlineMemoryFloor, projectInlineRecallReceipt } from './inline-projection.js';

import { patchRecallTabs } from './recall-tabs.js';

const RETRY_DELAYS = Object.freeze([0, 80, 180, 320, 500, 850, 1300, 2000, 3000, 4200]);
const HOST_SELECTOR = '[data-qqj-inline-host="true"]';
const OBSERVED_ATTRIBUTES = Object.freeze(['mesid', 'data-mesid', 'data-message-id', 'class', 'is_user']);
const INLINE_STYLE = `
:host{display:block;max-width:100%;box-sizing:border-box;color:inherit;font:inherit;background:transparent;text-shadow:none;--qqj-inline-knot:#a8322f;--qqj-inline-line:color-mix(in srgb,currentColor 18%,transparent)}
*,*::before,*::after{box-sizing:border-box}.card{position:relative;margin:8px 0 2px;padding:1px 5px 2px 10px;max-width:100%;color:inherit;background:transparent;border:1px solid var(--qqj-inline-line);border-left:2px solid var(--qqj-inline-knot);border-radius:8px}
.head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px;min-height:35px}.mark{position:absolute;left:0;top:18px;width:0;height:0;z-index:1;color:var(--qqj-inline-knot);pointer-events:none}.knot{position:absolute;left:-5px;top:-5px;width:9px;height:9px;border:1.5px solid currentColor;transform:rotate(45deg);border-radius:1px;background:transparent}.knot::after{content:"";position:absolute;inset:2px;background:currentColor;border-radius:1px}
.toggle,.extract{font:inherit;color:inherit;background:none;border:0;box-shadow:none;border-radius:7px;min-height:32px;cursor:pointer}.toggle{min-width:0;text-align:left;padding:2px 3px;display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);align-items:center;gap:6px}.title{min-width:0;font-size:12px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status{justify-self:start;min-width:0;max-width:100%;padding:1px 6px;border-radius:999px;font-size:10.5px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:color-mix(in srgb,currentColor 9%,transparent);color:inherit}.status.ready{background:color-mix(in srgb,#56a875 18%,transparent)}.status.running{background:color-mix(in srgb,#4c9bd1 18%,transparent)}.status.review{background:color-mix(in srgb,#d79a35 19%,transparent)}.status.error{background:color-mix(in srgb,#c84a46 17%,transparent)}
.extract{width:32px;height:32px;padding:0;display:grid;place-items:center;font-family:"Font Awesome 6 Free","Font Awesome 5 Free",sans-serif;font-size:12px;font-weight:900;line-height:1}.extract[hidden]{display:none}.extract:disabled{cursor:default;opacity:.42}.toggle:focus-visible,.extract:focus-visible{outline:2px solid var(--qqj-inline-knot);outline-offset:1px}
.body{padding:4px 6px 9px 3px;font-size:13px;line-height:1.75;overflow-wrap:anywhere}.body[hidden]{display:none}.facts{display:grid;gap:0;margin:0;font-size:11px;line-height:1.5;opacity:.68}.meta-row{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.summary{margin:10px 0 0;font-size:13px;line-height:1.75;white-space:pre-wrap}.assistant .summary{padding-top:10px;border-top:1px solid var(--qqj-inline-line)}.body > .error{margin:7px 0 0;color:#a8322f;font-size:11px;line-height:1.55;white-space:pre-wrap}
@media(max-width:360px){.card{padding-left:8px}.head{grid-template-columns:minmax(0,1fr) auto;gap:2px}.toggle{gap:4px;padding-inline:2px}.body{padding-left:2px}.title{font-size:11.5px}.status{font-size:10px}}
@media(prefers-reduced-motion:reduce){.toggle,.extract{scroll-behavior:auto}}
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

function createCard(documentRef, host, kind, expanded, onToggle, onExtract) {
  const root = host.attachShadow({ mode: 'open' });
  const style = documentRef.createElement('style'); style.textContent = INLINE_STYLE;
  const card = documentRef.createElement('article'); card.className = `card ${kind}`;
  const head = documentRef.createElement('div'); head.className = 'head';
  const mark = documentRef.createElement('span'); mark.className = 'mark'; mark.setAttribute?.('aria-hidden', 'true');
  const knot = documentRef.createElement('span'); knot.className = 'knot'; mark.append(knot);
  const toggle = documentRef.createElement('button'); toggle.type = 'button'; toggle.className = 'toggle';
  const title = documentRef.createElement('span'); title.className = 'title';
  const status = documentRef.createElement('span'); status.className = 'status';
  append(toggle, title, status);
  const extract = documentRef.createElement('button'); extract.type = 'button'; extract.className = 'extract'; extract.textContent = '\uf2f1'; extract.title = '重新提取本楼摘要'; extract.setAttribute?.('aria-label', '重新提取本楼摘要');
  const body = documentRef.createElement('div'); body.className = 'body';
  const facts = documentRef.createElement('div'); facts.className = 'facts';
  const time = documentRef.createElement('div'), locations = documentRef.createElement('div'), people = documentRef.createElement('div');
  time.className = 'meta-row time'; locations.className = 'meta-row locations'; people.className = 'meta-row people'; append(facts, time, locations, people);
  const fields = { time, locations, people };
  const summary = documentRef.createElement('p'); summary.className = 'summary';
  const error = documentRef.createElement('p'); error.className = 'error';
  append(body, facts, summary, error); append(head, toggle, extract); append(card, mark, head, body); append(root, style, card);
  const view = { host, root, card, mark, knot, toggle, title, status, extract, body, facts, fields, summary, error, kind, expanded, signature: '', projection: null, extracting: false };
  toggle.addEventListener('click', () => onToggle(view));
  extract.addEventListener('click', () => onExtract(view));
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
  const memoryIndices = new Map(), duplicateMemoryFloorIds = new Set();
  if (memoryMatchesChat) for (const floor of state?.floors ?? []) {
    const floorId = typeof floor?.floorId === 'string' ? floor.floorId.trim() : '';
    if (!floorId || !validIndex(floor.messageIndex)) continue;
    if (memoryIndices.has(floorId)) {
      memoryIndices.delete(floorId);
      duplicateMemoryFloorIds.add(floorId);
    } else if (!duplicateMemoryFloorIds.has(floorId)) memoryIndices.set(floorId, floor.messageIndex);
  }
  return Object.freeze({
    messageIndexFor(floorId) {
      if (!floorId || duplicateMarkerFloorIds.has(floorId)) return null;
      if (markerIndices.has(floorId)) return markerIndices.get(floorId);
      return duplicateMemoryFloorIds.has(floorId) ? null : (memoryIndices.get(floorId) ?? null);
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
    view.extract.hidden = true; view.extract.disabled = true;
    patchRecallTabs(view, projection, documentRef, sourceIndex, groupExpanded);
    patchExpanded(view); return;
  }
  const signature = JSON.stringify(projection);
  if (view.signature === signature) {
    view.extract.hidden = false; view.extract.disabled = view.extracting || !projection.canExtract;
    patchExpanded(view); return;
  }
  view.signature = signature; view.projection = projection;
  const title = projection.kind === 'user' ? '千千结 · 本轮召回' : validIndex(projection.messageIndex) ? `第 ${projection.messageIndex} 个结` : '本楼记忆';
  view.labelTitle = title; setText(view.title, title); view.title.title = title;
  setText(view.status, projection.statusText); view.status.className = `status${statusTone(projection) ? ` ${statusTone(projection)}` : ''}`;
  if (projection.kind === 'assistant') {
    view.facts.hidden = false;
    setText(view.fields.time, `时间 ${projection.time}`); setText(view.fields.locations, `地点 ${projection.locations}`); setText(view.fields.people, `人物 ${projection.people}`);
    setText(view.summary, projection.summary); setText(view.error, projection.error); view.error.hidden = !projection.error;
    const extractLabel = `重新提取${title}摘要`; view.extract.title = extractLabel; view.extract.setAttribute?.('aria-label', extractLabel);
    view.extract.hidden = false; view.extract.disabled = view.extracting || !projection.canExtract;
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
  let palette = Object.freeze({ knot: '#a8322f', line: 'color-mix(in srgb,currentColor 18%,transparent)' });
  const receiptCache = new WeakMap();
  const owner = {};

  const applyPalette = host => {
    setStyleProperty(host?.style, '--qqj-inline-knot', palette.knot);
    setStyleProperty(host?.style, '--qqj-inline-line', palette.line);
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
      view = host.__qqjInlineCard ?? createCard(documentRef, host, kind, expanded.get(stateKey) === true, onToggle, onExtract);
      view.stateKey = stateKey; view.kind = kind; cards.set(messageIndex, view);
    }
    return view;
  };

  const liveRecallFor = (state, chatId, messageIndex) => {
    if (state?.activeRecall?.chatId === chatId && state.activeRecall.userMessageIndex === messageIndex) return Object.freeze({ status: 'running', statusText: '寻回中', summary: '正在生成本轮召回回执。', injectionText: '', selectedFloors: Object.freeze([]), historyGroups: Object.freeze([]), kind: 'user' });
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

  const updateUser = (view, message, messageIndex, chatId, sourceIndex, recallState, currentSession) => {
    const live = liveRecallFor(recallState, chatId, messageIndex);
    const receipt = message.extra?.[RECALL_RECEIPT_KEY];
    if (!receipt || typeof receipt !== 'object') { patchView(view, live ?? projectInlineRecallReceipt(null), documentRef, sourceIndex, groupExpanded); return; }
    const messageText = message.mes, stamp = receiptStamp(receipt);
    const sameSettledReceipt = view.receiptIdentity === receipt && view.receiptMessageText === messageText && view.receiptStamp === stamp && view.receiptChatId === chatId && view.receiptSettled === true;
    if (live) patchView(view, live, documentRef, sourceIndex, groupExpanded);
    else if (sameSettledReceipt) { patchView(view, view.projection, documentRef, sourceIndex, groupExpanded); return; }
    else patchView(view, Object.freeze({ status: 'running', statusText: '正在核验历史回执', summary: '正在核验这一楼保存的召回记录。', injectionText: '', selectedFloors: Object.freeze([]), historyGroups: Object.freeze([]), kind: 'user' }), documentRef, sourceIndex, groupExpanded);
    void historicalProjection(message, chatId, messageIndex, stamp).then(result => {
      if (!active || currentSession !== session || message.mes !== messageText || message.extra?.[RECALL_RECEIPT_KEY] !== receipt || receiptStamp(receipt) !== stamp || cards.get(messageIndex) !== view) return;
      let latestSnapshot;
      try { latestSnapshot = hostAdapter.snapshot(); } catch { return; }
      const latestChat = Array.isArray(latestSnapshot?.chat) ? latestSnapshot.chat : [];
      const latestChatId = String(latestSnapshot?.context?.chatMetadata?.qianqianjie?.chatId ?? '').trim();
      const latestChatKey = `${latestChatId || latestSnapshot?.chatId || 'no-chat'}|${latestSnapshot?.chatId || ''}`;
      if (latestChatKey !== activeChatKey || latestChatId !== chatId || latestChat[messageIndex] !== message) return;
      view.receiptIdentity = receipt; view.receiptMessageText = messageText; view.receiptStamp = stamp; view.receiptChatId = chatId; view.receiptSettled = true;
      const latestLive = liveRecallFor(recallRuntime.getState(), chatId, messageIndex);
      const projection = latestLive?.status === 'running' ? latestLive : result ? projectInlineRecallReceipt(result) : (latestLive ?? projectInlineRecallReceipt(null));
      patchView(view, projection, documentRef, createSourceIndex(latestChat, latestChatId, memoryRuntime.getState()), groupExpanded);
    });
  };

  const refresh = () => {
    if (!active || destroyed || !documentRef?.querySelector) return true;
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
    const currentSession = session;
    const chatRoot = documentRef.querySelector('#chat');
    if (!chatRoot?.querySelectorAll) return false;
    const chosen = new Map();
    for (const element of chatRoot.querySelectorAll('.mes')) {
      const messageIndex = resolveInlineMessageIndex(element);
      const message = validIndex(messageIndex) ? chat[messageIndex] : null;
      const role = classifyInlineMessage(message);
      if (!role) continue;
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
      if (candidate.role === 'assistant') patchView(view, projectInlineMemoryFloor(memoryState, messageIndex, assistantSequence.get(messageIndex)), documentRef, sourceIndex, groupExpanded);
      else updateUser(view, chat[messageIndex], messageIndex, chatId, sourceIndex, recallState, currentSession);
    }
    for (const [messageIndex, view] of [...cards]) if (!chosen.has(messageIndex)) { remove(view.host); cards.delete(messageIndex); }
    for (const host of documentRef.querySelectorAll(HOST_SELECTOR)) {
      const index = resolveInlineMessageIndex(host);
      if (!validIndex(index) || cards.get(index)?.host !== host) remove(host);
    }
    const renderableCount = chat.reduce((count, message) => count + (classifyInlineMessage(message) ? 1 : 0), 0);
    if (renderableCount > 0 && chosen.size === 0) complete = false;
    for (const messageIndex of expectedIndices) if (classifyInlineMessage(chat[messageIndex]) && !chosen.has(messageIndex)) complete = false;
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
  function setAppearance(value) {
    palette = Object.freeze({
      knot: paletteColor(value?.palette?.knot, '#a8322f'),
      line: paletteColor(value?.palette?.line, 'color-mix(in srgb,currentColor 18%,transparent)'),
    });
    for (const view of cards.values()) applyPalette(view.host);
    return palette;
  }
  function destroy() { stop(); destroyed = true; clearRetry(); removeAll(); expanded.clear(); groupExpanded.clear(); }

  return Object.freeze({ start, stop, setEnabled, setAppearance, destroy, schedule, refresh, getDebugState: () => Object.freeze({ active, destroyed, session, cards: cards.size, observing: Boolean(observer), retrying: timer !== null, eventBindings: eventBindings.length }) });
}
