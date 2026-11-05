// Recall-only presentation; source indices and UI state belong to the owning chat and receipt.
import { scaleCssFontSizes, scaleCssSpacing } from "./font-scale.js";
import { sharedUiCss } from "./shared-ui-style.js";
import { inlineRecallPersonKey } from "./inline-projection.js";
export function patchRecallTabs(card, projection, doc, sourceIndex, uiStates) {
  const floorIds = [...new Set([
    ...(projection.selectedFloors ?? []).map((item) => item.floorId),
    ...(projection.personHistoryItems ?? []).map(item => (projection.selectedFloors ?? []).find(floor => floor.assistantSeq === item.assistantSeq)?.floorId),
    ...(projection.objectItems ?? []).map((item) => item.sourceFloorId),
    ...(projection.stateItems ?? []).map((item) => item.sourceFloorId),
    ...(projection.cseChangeItems ?? []).flatMap((item) => [
      item.floorId,
      item.before?.sourceFloorId,
      item.after?.sourceFloorId
    ])
  ].filter(Boolean))];
  const sources = new Map(floorIds.map((id) => [id, {
    messageIndex: sourceIndex?.messageIndexFor?.(id) ?? null,
    source: sourceIndex?.sourceFor?.(id) ?? null
  }]));
  const signature = JSON.stringify([projection, [...sources]]);
  if (card.recallSignature === signature) return;
  card.recallSignature = signature;
  const previous = uiStates.get(card.stateKey), receiptKey = projection.receiptKey ?? null;
  const state = previous?.receiptKey === receiptKey ? previous : {
    tab: previous?.tab ?? "events",
    event: null,
    person: null,
    object: null,
    receiptKey
  };
  uiStates.set(card.stateKey, state);
  const node = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const button = (cls, text) => {
    const n = node("button", cls, text);
    n.type = "button";
    return n;
  };
  const style = card.recallStyle ?? node("style");
  style.textContent = scaleCssSpacing(scaleCssFontSizes(`${sharedUiCss}
    .recall-design [hidden]{display:none!important}
    .recall-design{font-size:var(--qqj-font-body);line-height:1.7;--muted:var(--qqj-inline-soft,currentColor)}
    .recall-design button{font:inherit;color:inherit;cursor:pointer;box-shadow:none;text-shadow:none}
    .recall-design button:focus-visible{outline:2px solid var(--qqj-inline-knot);outline-offset:2px}
    .recall-tabs{display:flex;gap:var(--qqj-space-group);border-bottom:1px solid var(--qqj-inline-line);margin-bottom:var(--qqj-space-small)}
    .recall-design .recall-tab{position:relative;width:auto;min-width:0;border:0;border-radius:0;background:none;padding:var(--qqj-compact-pad-y) var(--qqj-compact-pad-x);font-size:var(--qqj-font-subheading);line-height:var(--qqj-compact-line);color:var(--qqj-control-fg,var(--qqj-action-color))}
    .recall-tab[aria-selected=true]{font-weight:650;color:var(--qqj-inline-knot)}
    .recall-tab[aria-selected=true]::after{content:'';position:absolute;bottom:-1px;left:var(--qqj-compact-pad-x);right:var(--qqj-compact-pad-x);height:2px;background:var(--qqj-inline-knot)}
    .recall-directory-entry+.recall-directory-entry{border-top:1px solid var(--qqj-inline-line)}
    .recall-design .recall-directory-toggle{display:block;width:100%;min-width:0;border:0;border-radius:var(--qqj-radius-control);padding:var(--qqj-space-group) var(--qqj-compact-pad-x);background:transparent;text-align:left}
    .recall-directory-toggle[aria-expanded=true]{padding-bottom:calc(2px * var(--qqj-ui-scale,1))}
    .recall-entry-lines{display:grid;gap:calc(2px * var(--qqj-ui-scale,1));min-width:0}
    .recall-entry-title{font-size:var(--qqj-font-body);line-height:1.6;font-weight:650;overflow-wrap:anywhere}
    .recall-entry-excerpt{font-size:var(--qqj-font-body);line-height:1.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
    .recall-entry-meta,.event-caption,.current-caption,.change-caption{font-size:var(--qqj-font-caption);line-height:1.6;color:var(--muted);overflow-wrap:anywhere}
    .recall-directory-detail{padding:0 var(--qqj-compact-pad-x) var(--qqj-compact-pad-y)}
    .recall-directory-detail>:last-child,.current-state>:last-child,.change-entry>:last-child{margin-bottom:0}
    .recall-static-entry .recall-directory-toggle{cursor:default;padding:calc(8px * var(--qqj-button-scale,.85))}
    .recall-static-entry .recall-entry-excerpt{white-space:normal}
    .event-caption,.current-caption,.change-caption{margin:0 0 var(--qqj-space-small)}
    .event-copy,.current-copy{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.85}
    .event-fragment+.event-fragment,.current-state+.current-state,.change-entry+.change-entry{margin-top:var(--qqj-space-section)}
    .recall-group-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--qqj-space-small);margin:0 0 var(--qqj-space-small);padding:0 var(--qqj-compact-pad-x)}
    .recall-group-head:not(:first-child){margin-top:var(--qqj-space-section)}
    .recall-section-heading{font-size:var(--qqj-font-body);line-height:1.6;font-weight:650;margin:0;padding:var(--qqj-compact-pad-y) 0}
    .change-row{display:grid;grid-template-columns:var(--qqj-font-body) minmax(0,1fr);gap:var(--qqj-space-small);padding:calc(2px * var(--qqj-ui-scale,1)) 0;font-size:var(--qqj-font-body);line-height:1.85}
    .change-sign{font-weight:600;user-select:none}.change-added .change-sign{color:var(--qqj-inline-success)}
    .change-removed{color:var(--muted)}.change-removed .change-copy{text-decoration:line-through;text-decoration-thickness:1px}
    .change-copy{white-space:pre-wrap;overflow-wrap:anywhere}.change-visibility{display:block;font-size:var(--qqj-font-caption);line-height:1.6;color:var(--muted)}
    .recall-empty{margin:var(--qqj-space-group) var(--qqj-compact-pad-x);color:var(--muted);font-size:var(--qqj-font-body);line-height:1.7}
  `, "--qqj-inline-fixed-scale"));
  if (!card.recallStyle) {
    card.root.append(style);
    card.recallStyle = style;
  }
  const root = node("div", "recall-design"), tabs = node("div", "recall-tabs"), events = node("section", "recall-events"), people = node("section", "recall-people"), objects = node("section", "recall-objects");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "召回内容");
  const eventTab = button("recall-tab", "旧事"), peopleTab = button("recall-tab", "人物"), objectsTab = button("recall-tab", "物"), prefix = `recall-${card.host.dataset.messageId}`;
  for (const [tab, panel, key] of [[
    eventTab,
    events,
    "events"
  ], [
    peopleTab,
    people,
    "people"
  ], [objectsTab, objects, "objects"]]) {
    tab.id = `${prefix}-${key}-tab`;
    panel.id = `${prefix}-${key}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panel.id);
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
  }
  const selectTab = (selected) => {
    state.tab = selected === eventTab ? "events" : selected === peopleTab ? "people" : "objects";
    for (const [tab, panel] of [[eventTab, events], [peopleTab, people], [objectsTab, objects]]) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      panel.hidden = !active;
    }
  };
  for (const tab of [eventTab, peopleTab, objectsTab]) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (![
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End"
      ].includes(event.key)) return;
      event.preventDefault();
      const allTabs = [eventTab, peopleTab, objectsTab];
      const step = event.key === "ArrowLeft" ? -1 : 1;
      const target = event.key === "Home" ? eventTab : event.key === "End" ? objectsTab : allTabs[(allTabs.indexOf(tab) + step + allTabs.length) % allTabs.length];
      selectTab(target);
      target.focus();
    });
  }
  const floorLabel = (id) => {
    const value = sources.get(id);
    if (value?.source?.frozen === true && Number.isSafeInteger(value.source.sourceOrigin?.sourceMessageIndex)) return `旧第 ${value.source.sourceOrigin.sourceMessageIndex} 个结`;
    return Number.isSafeInteger(value?.messageIndex) ? `第 ${value.messageIndex} 个结` : "来源结号未提供";
  };
  const eventEntries = [], personEntries = [], objectEntries = [];
  const addEntry = (parent, entries, id, title, excerpt, meta, field, render, { static: isStatic = false, conditional = false } = {}) => {
    const entry = node("div", `recall-directory-entry recall-${field}-entry`), trigger = isStatic ? node("div", "recall-directory-toggle") : button("recall-directory-toggle"), lines = node("span", "recall-entry-lines"), detail = isStatic ? null : node("div", "recall-directory-detail");
    const excerptNode = node("span", "recall-entry-excerpt", excerpt);
    excerptNode.hidden = !excerpt;
    lines.append(node("span", "recall-entry-title", title), excerptNode);
    const metaNode = meta ? node("span", "recall-entry-meta", meta) : null;
    if (metaNode) lines.append(metaNode);
    trigger.append(lines);
    trigger.dataset.entryKey = id;
    if (detail) {
      detail.id = `${prefix}-${field}-${entries.length}`;
      trigger.setAttribute("aria-controls", detail.id);
      detail.setAttribute("role", "region");
      detail.setAttribute("aria-label", title);
      entry.append(trigger, detail);
    } else {
      entry.className += ' recall-static-entry';
      entry.append(trigger);
    }
    parent.append(entry);
    const view = {
      id,
      root: entry,
      trigger,
      detail,
      excerpt: excerptNode,
      meta: metaNode,
      render
    };
    entries.push(view);
    const paint = () => {
      for (const item of entries) {
        if (!item.detail) continue;
        const open = state[field] === item.id;
        item.trigger.setAttribute("aria-expanded", String(open));
        item.detail.hidden = !open;
        item.excerpt.hidden = open || !item.excerpt.textContent;
        if (item.meta) item.meta.hidden = open;
        if (open) item.render(item.detail);
        else item.detail.replaceChildren();
      }
    };
    if (!isStatic) trigger.addEventListener("click", () => {
      if (state[field] !== id && conditional && !excerpt.includes('\n') && excerptNode.clientWidth > 0 && excerptNode.scrollWidth <= excerptNode.clientWidth) return;
      state[field] = state[field] === id ? null : id;
      paint();
    });
    return view;
  };
  const groupHeader = (parent, title) => {
    const header = node('div', 'recall-group-head');
    header.append(node('h4', 'recall-section-heading', title));
    parent.append(header);
    return header;
  };
  const historyItems = projection.historyItems ?? [], itemFloors = new Map();
  for (const floor of projection.historyGroups ?? []) for (const item of floor.items) itemFloors.set(item, floor);
  const excerptFor = item => item.manualArtifact ? item.text : (item.displayText ?? item.text).replace(/^\[叙事回顾\] /u, '')
    .replace(/^(?:邻近背景；仅因时序相邻，不表示因果：|同人物与具体主题词关联，不表示因果：|来源关联：)/u, '')
    .replace(/^\[历史原文；时间未标注\] /u, '');
  for (const [section, title] of [['recent', '近期接续'], ['distant', '相关旧事']]) {
    const items = historyItems.map((item, index) => ({ item, index }))
      .filter(({ item }) => (item.section === 'recent' ? 'recent' : 'distant') === section);
    if (section === 'distant') items.sort((a, b) => b.item.assistantSeq - a.item.assistantSeq);
    if (!items.length) continue;
    groupHeader(events, title);
    for (const { item, index } of items) {
      const floor = itemFloors.get(item), source = floorLabel(floor?.floorId);
      const kind = item.manualArtifact ? '关键原文' : item.materialKind === 'sourceFragment' ? '原文片段' : item.materialKind === 'narrative' ? '叙事回顾' : '';
      const id = `floor:${floor?.floorId || `sequence-${item.assistantSeq}`}:${index}`;
      addEntry(events, eventEntries, id, source, excerptFor(item), [kind, item.materialCaption].filter(Boolean).join(' · '), 'event', detail => {
        detail.replaceChildren(node('p', 'event-copy', item.displayText ?? item.text), node('p', 'current-caption', [source, kind, item.materialCaption].filter(Boolean).join(' · ')));
      });
    }
  }
  if (!eventEntries.some(entry => entry.id === state.event)) state.event = null;
  const peopleById = new Map(), personFor = (item) => {
    const id = inlineRecallPersonKey(item);
    if (!peopleById.has(id)) peopleById.set(id, {
      id,
      name: item.subject,
      states: [],
      changes: []
    });
    return peopleById.get(id);
  };
  for (const item of projection.stateItems ?? []) {
    const person = personFor(item), same = person.states.find((value) => JSON.stringify([
      value.text,
      value.toward,
      value.towardEntityId,
      value.layer,
      value.visibility
    ]) === JSON.stringify([
      item.text,
      item.toward,
      item.towardEntityId,
      item.layer,
      item.visibility
    ]));
    if (same) {
      if (item.sourceFloorId && !same.sourceFloorIds.includes(item.sourceFloorId)) same.sourceFloorIds.push(item.sourceFloorId);
    } else person.states.push({
      ...item,
      sourceFloorIds: item.sourceFloorId ? [item.sourceFloorId] : []
    });
  }
  for (const item of projection.cseChangeItems ?? []) {
    const person = personFor(item), key = JSON.stringify([
      item.floorId,
      item.assistantSeq,
      item.layer,
      item.action,
      item.before,
      item.after
    ]);
    if (!person.changes.some((value) => value.key === key)) person.changes.push({
      ...item,
      key
    });
  }
  const layers = {
    core: "核心",
    adaptive: "适应",
    situational: "情境"
  }, visibility = {
    private: "私密",
    observable: "可观察",
    expressed: "已表达",
    shared: "已共享",
    authorial: "作者设定"
  }, actions = {
    add: "新增",
    update: "更新",
    remove: "移除"
  };
  const directed = (value) => `${value.toward ? `→ ${value.toward}：` : ""}${value.text}`;
  const sourceCaption = (item) => item.origin === "manual" ? "人工设置" : item.sourceFloorIds?.length ? item.sourceFloorIds.map(floorLabel).join("、") : item.sourceFloorId ? floorLabel(item.sourceFloorId) : "";
  if (!peopleById.has(state.person) && !(projection.personHistoryItems ?? []).some((_, index) => `person-history:${index}` === state.person)) state.person = null;
  if (peopleById.size) groupHeader(people, '人物状态');
  for (const person of peopleById.values()) {
    const recent = [...person.changes].sort((a, b) => (b.assistantSeq ?? 0) - (a.assistantSeq ?? 0))[0], excerpt = person.states.length ? directed(person.states[0]) : recent ? `${actions[recent.action] ?? recent.action}：${directed(recent.action === "remove" ? recent.before : recent.after ?? recent.before)}` : "";
    const counts = [person.states.length ? `当前状态 ${person.states.length} 条` : "", person.changes.length ? `相关变化 ${person.changes.length} 条` : ""].filter(Boolean).join(" · ");
    addEntry(people, personEntries, person.id, person.name, excerpt, counts, "person", (detail) => {
      detail.replaceChildren();
      if (person.states.length) {
        for (const item of person.states) {
          const block = node("div", "current-state");
          block.append(node("p", "current-copy", directed(item)));
          const info = [`当前状态 ${person.states.length} 条`, visibility[item.visibility], sourceCaption(item)].filter(Boolean).join(" · ");
          if (info) block.append(node("p", "current-caption", info));
          detail.append(block);
        }
      }
      if (person.changes.length) {
        for (const item of [...person.changes].sort((a, b) => (b.assistantSeq ?? 0) - (a.assistantSeq ?? 0))) {
          const block = node("div", "change-entry");

          const row = (value, removed) => {
            if (!value?.text) return;
            const group = node("div", `change-row ${removed ? "change-removed" : "change-added"}`), sign = node("span", "change-sign", removed ? "−" : "+");
            sign.setAttribute("role", "img");
            sign.setAttribute("aria-label", removed ? "删除" : "新增");
            const content = node("div");
            content.append(node(removed ? "del" : "span", "change-copy", directed(value)));
            if (visibility[value.visibility]) content.append(node("span", "change-visibility", visibility[value.visibility]));
            group.append(sign, content);
            block.append(group);
          };
          if (item.action !== "add") row(item.before, true);
          if (item.action !== "remove") row(item.after, false);
          block.append(node("p", "change-caption", [actions[item.action] ?? item.action, item.layer === "situational" ? null : layers[item.layer], floorLabel(item.floorId)].filter(Boolean).join(" · ")));
          detail.append(block);
        }
      }
    });
  }
  const personHistory = projection.personHistoryItems ?? [];
  if (personHistory.length) {
    groupHeader(people, `历史承诺与计划 · ${personHistory.length} 条`);
    personHistory.forEach((item, index) => {
      const source = floorLabel((projection.selectedFloors ?? []).find(floor => floor.assistantSeq === item.assistantSeq)?.floorId);
      addEntry(people, personEntries, `person-history:${index}`, source, item.displayText ?? item.text, '历史承诺或计划', 'person', detail => {
        detail.replaceChildren(node('p', 'person-history-copy event-copy', item.displayText ?? item.text), node('p', 'current-caption', [source, item.materialCaption].filter(Boolean).join(' · ')));
      });
    });
  }
  if (!(projection.objectItems ?? []).some(item => item.id === state.object)) state.object = null;
  for (const [group, title] of [['qianshi', '千事进度'], ['time', '近期事项'], ['place', '地点']]) {
    const items = (projection.objectItems ?? []).filter(item => item.group === group);
    if (!items.length) continue;
    groupHeader(objects, title);
    for (const item of items) {
      const copy = item.bodyText ?? item.displayText ?? item.text;
      addEntry(objects, objectEntries, item.id, item.title, copy === item.title ? '' : copy,
        item.caption || '', 'object', detail => {
          detail.replaceChildren();
          if (copy) detail.append(node('p', 'object-copy event-copy', copy));
          const caption = item.caption;
          if (caption) detail.append(node('p', 'current-caption', caption));
        }, { static: item.static || !copy || copy === item.title, conditional: true });
    }
  }
  for (const [field, entries] of [["event", eventEntries], ["person", personEntries], ["object", objectEntries]]) for (const item of entries) {
    if (!item.detail) continue;
    const open = state[field] === item.id;
    item.trigger.setAttribute("aria-expanded", String(open));
    item.detail.hidden = !open;
    item.excerpt.hidden = open || !item.excerpt.textContent;
    if (item.meta) item.meta.hidden = open;
    if (open) item.render(item.detail);
  }
  if (!["running", "error"].includes(projection.status)) {
    if (!eventEntries.length) events.append(node("p", "recall-empty", "本轮没有需要展示的剧情回忆。"));
    if (!objectEntries.length) objects.append(node("p", "recall-empty", "本轮未召回事项或地点参照。"));
    if (!personEntries.length) people.append(node("p", "recall-empty", "本轮未召回人物状态或变化。"));
  }
  tabs.append(eventTab, peopleTab, objectsTab);
  root.append(tabs, events, people, objects);
  selectTab(state.tab === 'objects' && objectEntries.length ? objectsTab
    : state.tab === 'people' && personEntries.length ? peopleTab
    : eventEntries.length ? eventTab : personEntries.length ? peopleTab : objectEntries.length ? objectsTab : eventTab);
  card.body.replaceChildren(root);
  card.recallUi = {
    root,
    eventTab,
    peopleTab,
    objectsTab,
    objects,
    events,
    people,
    eventEntries,
    personEntries,
    objectEntries
  };
}
