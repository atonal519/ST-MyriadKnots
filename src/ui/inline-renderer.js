import { projectHistoricalRecallReceipt, RECALL_RECEIPT_KEY } from '../v3/recall-runtime.js';
import { inspectMessageFloorAnchor } from '../v3/message-floor-anchor.js';
import { classifyInlineMessage, projectInlineMemoryFloor, projectInlineRecallReceipt } from './inline-projection.js';

const RETRY_DELAYS = Object.freeze([0, 80, 180, 320, 500, 850, 1300, 2000, 3000, 4200]);
const HOST_SELECTOR = '[data-qqj-inline-host="true"]';
const OBSERVED_ATTRIBUTES = Object.freeze(['mesid', 'data-mesid', 'data-message-id', 'class', 'is_user']);
const INLINE_STYLE = `
:host{display:block;max-width:100%;box-sizing:border-box;color:inherit;font:inherit;background:transparent;text-shadow:none;--qqj-inline-knot:#a8322f;--qqj-inline-line:color-mix(in srgb,currentColor 18%,transparent)}
*,*::before,*::after{box-sizing:border-box}.card{position:relative;margin:8px 0 2px;padding:1px 5px 2px 10px;max-width:100%;color:inherit;background:transparent;border:1px solid var(--qqj-inline-line);border-left:2px solid var(--qqj-inline-knot);border-radius:8px}
.head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px;min-height:35px}.mark{position:absolute;left:0;top:18px;width:0;height:0;z-index:1;color:var(--qqj-inline-knot);pointer-events:none}.knot{position:absolute;left:-5px;top:-5px;width:9px;height:9px;border:1.5px solid currentColor;transform:rotate(45deg);border-radius:1px;background:transparent}.knot::after{content:"";position:absolute;inset:2px;background:currentColor;border-radius:1px}
.toggle,.extract{font:inherit;color:inherit;background:none;border:0;box-shadow:none;border-radius:7px;min-height:32px;cursor:pointer}.toggle{min-width:0;text-align:left;padding:2px 3px;display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);align-items:center;gap:6px}.title{min-width:0;font-size:12px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status{justify-self:start;min-width:0;max-width:100%;padding:1px 6px;border-radius:999px;font-size:10.5px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:color-mix(in srgb,currentColor 9%,transparent);color:inherit}.status.ready{background:color-mix(in srgb,#56a875 18%,transparent)}.status.running{background:color-mix(in srgb,#4c9bd1 18%,transparent)}.status.review{background:color-mix(in srgb,#d79a35 19%,transparent)}.status.error{background:color-mix(in srgb,#c84a46 17%,transparent)}
.extract{width:32px;height:32px;padding:0;display:grid;place-items:center;font-family:"Font Awesome 6 Free","Font Awesome 5 Free",sans-serif;font-size:12px;font-weight:900;line-height:1}.extract[hidden]{display:none}.extract:disabled{cursor:default;opacity:.42}.toggle:focus-visible,.extract:focus-visible{outline:2px solid var(--qqj-inline-knot);outline-offset:1px}
.body{padding:4px 6px 9px 3px;font-size:13px;line-height:1.75;overflow-wrap:anywhere}.body[hidden]{display:none}.facts{display:grid;gap:0;margin:0;font-size:11px;line-height:1.5;opacity:.68}.meta-row{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.summary{margin:10px 0 0;font-size:13px;line-height:1.75;white-space:pre-wrap}.assistant .summary{padding-top:10px;border-top:1px solid var(--qqj-inline-line)}.recall-items{display:grid;gap:9px;margin:3px 0 0}.recall-line{display:grid;gap:3px;min-width:0;padding:4px 0 7px;border-bottom:1px solid var(--qqj-inline-line)}.recall-line:last-child{border-bottom:0}.recall-line-title{font-size:13px;line-height:1.45}.recall-group{min-width:0;padding:1px 0 5px}.recall-group>summary{cursor:pointer;display:flex;align-items:baseline;gap:7px;min-width:0;padding:3px 0;font-size:12px;font-weight:650;line-height:1.5}.recall-floor{font-size:10.5px;font-weight:400;opacity:.62}.recall-texts{display:grid;gap:4px;padding:3px 0 2px 16px}.recall-text{font-size:12px;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere}.recall-line-state{font-size:11.5px;line-height:1.65;white-space:pre-wrap}.states,.cse-changes{margin:10px 0 0}.states>summary,.cse-changes>summary{cursor:pointer;font-size:11px;line-height:1.5;opacity:.7}.state-items,.cse-change-items{display:none;gap:6px;margin-top:6px}.states[open]>.state-items,.cse-changes[open]>.cse-change-items{display:grid}.state-item,.cse-change-item{font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.cse-change-floor{margin-left:5px;font-size:10.5px;opacity:.62}.body > .error{margin:7px 0 0;color:#a8322f;font-size:11px;line-height:1.55;white-space:pre-wrap}
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
  const recallItems = documentRef.createElement('div'); recallItems.className = 'recall-items';
  const states = documentRef.createElement('details'); states.className = 'states';
  const statesTitle = documentRef.createElement('summary'); statesTitle.className = 'states-title';
  const stateItems = documentRef.createElement('div'); stateItems.className = 'state-items'; append(states, statesTitle, stateItems);
  const cseChanges = documentRef.createElement('details'); cseChanges.className = 'cse-changes';
  const cseChangesTitle = documentRef.createElement('summary'); cseChangesTitle.className = 'cse-changes-title';
  const cseChangeItems = documentRef.createElement('div'); cseChangeItems.className = 'cse-change-items'; append(cseChanges, cseChangesTitle, cseChangeItems);
  const error = documentRef.createElement('p'); error.className = 'error';
  append(body, facts, summary, recallItems, states, cseChanges, error); append(head, toggle, extract); append(card, mark, head, body); append(root, style, card);
  const view = { host, root, card, mark, knot, toggle, title, status, extract, body, facts, fields, summary, recallItems, states, statesTitle, stateItems, cseChanges, cseChangesTitle, cseChangeItems, error, kind, expanded, signature: '', projection: null, extracting: false };
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

const CSE_LAYER_TEXT = Object.freeze({ core: '核心', adaptive: '适应', situational: '情境' });
const CSE_VISIBILITY_TEXT = Object.freeze({ private: '仅主体知晓', observable: '可观察', expressed: '已表达', shared: '已共享', authorial: '作者视角' });

function renderCseChange(item, projection, sourceIndex, currentReference = '见上方当前快照（同一来源）') {
  const messageIndex = sourceIndex?.messageIndexFor?.(item.floorId) ?? null;
  const sourceKey = value => value?.stateId ? `id:${value.stateId}`
    : value?.sourceFloorId || value?.sourceDeltaId ? `source:${value.sourceFloorId ?? ''}|${value.sourceDeltaId ?? ''}|${value.text ?? ''}` : '';
  const currentEquivalent = item.after && (projection.stateItems ?? []).some(current => current.subjectEntityId === item.subjectEntityId
    && current.layer === item.layer && sourceKey(current) && sourceKey(current) === sourceKey(item.after));
  const side = (value, sameAsCurrent = false) => sameAsCurrent ? currentReference
    : value?.text ? `${value.text}${CSE_VISIBILITY_TEXT[value.visibility] ? `（${CSE_VISIBILITY_TEXT[value.visibility]}）` : ''}` : '';
  const before = side(item.before), after = side(item.after, currentEquivalent);
  const change = item.action === 'add' ? `新增：${after}`
    : item.action === 'remove' ? `移除：${before}（这是该楼当时移除的旧状态）`
      : item.action === 'update' ? `更新：${before} → ${after}`
        : `调整：${before} → ${after}`;
  return { assistantSeq: item.assistantSeq, text: `${item.subject} / ${CSE_LAYER_TEXT[item.layer] ?? item.layer} / ${change}`, messageIndex: validIndex(messageIndex) ? messageIndex : null };
}

function replaceRecallItems(view, projection, documentRef, sourceIndex, groupExpanded) {
  if ((projection.storylineGroups ?? []).length) {
    const rendered = projection.storylineGroups.map(line => ({
      storylineId: line.storylineId, title: line.title,
      floors: line.floors.map(group => {
        const messageIndex = sourceIndex?.messageIndexFor?.(group.floorId) ?? null;
        return { assistantSeq: group.assistantSeq, floorId: group.floorId, messageIndex: validIndex(messageIndex) ? messageIndex : null, texts: group.items.map(item => item.text) };
      }),
      states: line.stateItems.map(value => `${value.subject}${value.toward ? ` → ${value.toward}` : ''}：${value.text}`),
      changes: line.cseChangeItems.map(value => renderCseChange(value, projection, sourceIndex, '见本线末尾当前快照（同一来源）')),
    }));
    const signature = JSON.stringify(rendered);
    if (view.recallItems.dataset?.signature === signature) return;
    const lineNodes = rendered.map(line => {
      const section = documentRef.createElement('section'); section.className = 'recall-line';
      const title = documentRef.createElement('strong'); title.className = 'recall-line-title'; setText(title, line.title);
      append(section, title);
      const timeline = [
        ...line.floors.map(value => ({ kind: 'floor', assistantSeq: value.assistantSeq, value })),
        ...line.changes.map(value => ({ kind: 'change', assistantSeq: value.assistantSeq, value })),
      ].sort((a, b) => a.assistantSeq - b.assistantSeq || (a.kind === 'floor' ? -1 : 1));
      for (const entry of timeline) {
        if (entry.kind === 'change') {
          const node = documentRef.createElement('div'); node.className = 'recall-line-state';
          setText(node, `历史变化 · ${entry.value.text}${validIndex(entry.value.messageIndex) ? ` · 第 ${entry.value.messageIndex} 楼` : ''}`);
          append(section, node); continue;
        }
        const floor = entry.value;
        const stateKey = `${view.stateKey}:storyline:${line.storylineId}:${floor.floorId ?? floor.assistantSeq}`;
        const node = documentRef.createElement('details'); node.className = 'recall-group'; node.open = groupExpanded.get(stateKey) === true;
        const sourceNode = documentRef.createElement('summary'); sourceNode.className = 'recall-source';
        const floorTitle = validIndex(floor.messageIndex) ? `第 ${floor.messageIndex} 个结` : '来源结号未提供';
        const knotTitle = documentRef.createElement('span'); knotTitle.className = 'recall-knot'; setText(knotTitle, floorTitle); append(sourceNode, knotTitle);
        const textWrap = documentRef.createElement('div'); textWrap.className = 'recall-texts';
        for (const value of floor.texts) { const textNode = documentRef.createElement('div'); textNode.className = 'recall-text'; setText(textNode, value); append(textWrap, textNode); }
        const patchLabel = () => sourceNode.setAttribute?.('aria-label', `${node.open === true ? '折叠' : '展开'}${floorTitle}`);
        node.addEventListener('toggle', () => { groupExpanded.set(stateKey, node.open === true); patchLabel(); }); patchLabel(); append(node, sourceNode, textWrap); append(section, node);
      }
      for (const value of line.states) { const node = documentRef.createElement('div'); node.className = 'recall-line-state'; setText(node, `当前状态 · ${value}`); append(section, node); }
      return section;
    });
    view.recallItems.replaceChildren?.(...lineNodes);
    if (view.recallItems.dataset) view.recallItems.dataset.signature = signature;
    view.recallItems.hidden = lineNodes.length === 0;
    return;
  }
  const rendered = (projection.historyGroups ?? []).map(group => {
    const messageIndex = sourceIndex?.messageIndexFor?.(group.floorId) ?? null;
    return { assistantSeq: group.assistantSeq, floorId: group.floorId ?? null, messageIndex: validIndex(messageIndex) ? messageIndex : null, texts: group.items.map(item => item.text) };
  });
  const signature = JSON.stringify(rendered);
  if (view.recallItems.dataset?.signature === signature) return;
  const items = rendered.map(({ assistantSeq, floorId, messageIndex, texts }) => {
    const stateKey = `${view.stateKey}:recall:${floorId ?? assistantSeq}`;
    const node = documentRef.createElement('details'); node.className = 'recall-group'; node.open = groupExpanded.get(stateKey) === true;
    const sourceNode = documentRef.createElement('summary'); sourceNode.className = 'recall-source';
    const title = validIndex(messageIndex) ? `第 ${messageIndex} 个结` : '来源结号未提供';
    const knotTitle = documentRef.createElement('span'); knotTitle.className = 'recall-knot'; setText(knotTitle, title);
    append(sourceNode, knotTitle);
    const textWrap = documentRef.createElement('div'); textWrap.className = 'recall-texts';
    for (const text of texts) { const textNode = documentRef.createElement('div'); textNode.className = 'recall-text'; setText(textNode, text); append(textWrap, textNode); }
    const patchLabel = () => sourceNode.setAttribute?.('aria-label', `${node.open === true ? '折叠' : '展开'}${title}`);
    node.addEventListener('toggle', () => { groupExpanded.set(stateKey, node.open === true); patchLabel(); });
    patchLabel(); append(node, sourceNode, textWrap); return node;
  });
  view.recallItems.replaceChildren?.(...items);
  if (view.recallItems.dataset) view.recallItems.dataset.signature = signature;
  view.recallItems.hidden = items.length === 0;
}

function replaceStateItems(view, projection, documentRef) {
  const wanted = projection.stateItems ?? [];
  const signature = JSON.stringify(wanted);
  if (view.stateItems.dataset?.signature === signature) return;
  const items = wanted.map(item => {
    const node = documentRef.createElement('div'); node.className = 'state-item';
    setText(node, `${item.subject}${item.toward ? ` → ${item.toward}` : ''}：${item.text}`);
    return node;
  });
  view.stateItems.replaceChildren?.(...items);
  if (view.stateItems.dataset) view.stateItems.dataset.signature = signature;
  setText(view.statesTitle, `当前人物状态 ${items.length} 条`);
  view.states.hidden = items.length === 0;
}

function replaceCseChangeItems(view, projection, documentRef, sourceIndex) {
  const rendered = (projection.cseChangeItems ?? []).map(item => renderCseChange(item, projection, sourceIndex));
  const signature = JSON.stringify(rendered);
  if (view.cseChangeItems.dataset?.signature === signature) return;
  const items = rendered.map(item => {
    const node = documentRef.createElement('div'); node.className = 'cse-change-item';
    const text = documentRef.createElement('span'); text.className = 'cse-change-text'; setText(text, item.text);
    const floor = documentRef.createElement('span'); floor.className = 'cse-change-floor'; setText(floor, validIndex(item.messageIndex) ? `第 ${item.messageIndex} 楼` : '来源楼号未提供');
    append(node, text, floor); return node;
  });
  view.cseChangeItems.replaceChildren?.(...items);
  if (view.cseChangeItems.dataset) view.cseChangeItems.dataset.signature = signature;
  setText(view.cseChangesTitle, `人物状态历史变化 ${items.length} 条`);
  view.cseChanges.hidden = items.length === 0;
}

function statusTone(projection) {
  if (projection.kind === 'user') return '';
  if (['error', 'failed'].includes(projection.status)) return 'error';
  if (projection.status === 'running') return 'running';
  if (projection.status === 'ready') return 'ready';
  return '';
}

function patchView(view, projection, documentRef, sourceIndex, groupExpanded) {
  const signature = JSON.stringify(projection);
  if (view.signature === signature) {
    if (projection.kind === 'user') { replaceRecallItems(view, projection, documentRef, sourceIndex, groupExpanded); if (!(projection.storylineGroups ?? []).length) replaceCseChangeItems(view, projection, documentRef, sourceIndex); }
    else { view.extract.hidden = false; view.extract.disabled = view.extracting || !projection.canExtract; }
    patchExpanded(view); return;
  }
  view.signature = signature; view.projection = projection;
  const title = projection.kind === 'user' ? '千千结 · 本轮召回' : validIndex(projection.messageIndex) ? `第 ${projection.messageIndex} 个结` : '本楼记忆';
  view.labelTitle = title; setText(view.title, title); view.title.title = title;
  setText(view.status, projection.statusText); view.status.className = `status${statusTone(projection) ? ` ${statusTone(projection)}` : ''}`;
  if (projection.kind === 'assistant') {
    view.facts.hidden = false; view.recallItems.hidden = true; view.states.hidden = true; view.cseChanges.hidden = true;
    setText(view.fields.time, `时间 ${projection.time}`); setText(view.fields.locations, `地点 ${projection.locations}`); setText(view.fields.people, `人物 ${projection.people}`);
    setText(view.summary, projection.summary); setText(view.error, projection.error); view.error.hidden = !projection.error;
    const extractLabel = `重新提取${title}摘要`; view.extract.title = extractLabel; view.extract.setAttribute?.('aria-label', extractLabel);
    view.extract.hidden = false; view.extract.disabled = view.extracting || !projection.canExtract;
  } else {
    view.facts.hidden = true; view.extract.hidden = true; view.extract.disabled = true;
    setText(view.summary, projection.summary); view.summary.hidden = (projection.historyItems?.length ?? 0) > 0 || (projection.storylineGroups?.length ?? 0) > 0;
    setText(view.error, ''); view.error.hidden = true; replaceRecallItems(view, projection, documentRef, sourceIndex, groupExpanded);
    if ((projection.storylineGroups ?? []).length) { view.states.hidden = true; view.cseChanges.hidden = true; }
    else { replaceStateItems(view, projection, documentRef); replaceCseChangeItems(view, projection, documentRef, sourceIndex); }
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
