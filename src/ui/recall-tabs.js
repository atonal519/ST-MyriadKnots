// Recall-only presentation; source indices and UI state are scoped to the owning chat.
export function patchRecallTabs(card, projection, doc, sourceIndex, uiStates) {
  const floorIds = [...new Set([
    ...(projection.selectedFloors ?? []).map(item => item.floorId),
    ...(projection.cseChangeItems ?? []).map(item => item.floorId),
    ...(projection.stateProgressionItems ?? []).flatMap(item => [item.sourceFloorId, ...(item.evidence ?? []).map(value => value.floorId)]),
  ].filter(Boolean))];
  const sources = new Map(floorIds.map(id => [id, sourceIndex?.messageIndexFor?.(id) ?? null]));
  const signature = JSON.stringify([projection, [...sources]]);
  if (card.recallSignature === signature) return;
  card.recallSignature = signature;
  const state = uiStates.get(card.stateKey) ?? { tab:'events', event:null, person:null, floors:new Map() };
  uiStates.set(card.stateKey, state);
  const node = (tag, className, text) => {
    const value = doc.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const button = (className, text) => { const value = node('button', className, text); value.type = 'button'; return value; };
  const style = card.recallStyle ?? node('style');
  style.textContent = `
    .recall-design [hidden]{display:none!important}
    .recall-design{font-size:12px;line-height:1.7;padding:0 2px 3px;--soft:color-mix(in srgb,currentColor 5%,transparent);--muted:color-mix(in srgb,currentColor 57%,transparent)}
    .recall-design button{font:inherit;color:inherit;cursor:pointer;box-shadow:none;text-shadow:none}
    .recall-design button:focus-visible,.recall-design summary:focus-visible{outline:2px solid var(--qqj-inline-knot);outline-offset:3px}
    .recall-tabs{display:grid;grid-template-columns:1fr 1fr;gap:20px;border-bottom:1px solid var(--qqj-inline-line);margin-bottom:15px}
    .recall-tab{position:relative;border:0;background:none;padding:9px 10px 11px;font-size:14px!important;letter-spacing:.24em;opacity:.5}
    .recall-tab[aria-selected=true]{opacity:1;font-weight:650}
    .recall-tab[aria-selected=true]::after{content:'';position:absolute;bottom:-1px;left:22%;right:22%;height:2px;background:var(--qqj-inline-knot);border-radius:2px}
    .event-pills{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
    .event-pill{min-width:0;border:1px solid var(--qqj-inline-line);border-radius:999px;background:none;padding:5px 6px;font-size:11px!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .event-pill[aria-expanded=true]{border-color:var(--qqj-inline-knot);background:color-mix(in srgb,var(--qqj-inline-knot) 10%,transparent)}
    .event-display{margin-top:13px;padding:12px 13px;border-radius:7px;background:var(--soft);min-height:86px}
    .event-display.is-empty{display:grid;place-items:center;background:none;min-height:75px}
    .recall-empty{color:var(--muted);font-size:11px;margin:0}
    .event-caption{font-size:10px;color:var(--muted);margin:0 0 8px}
    .event-copy{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.9}
    .event-copy+.event-copy{margin-top:10px}
    .time-progression{margin-top:14px;border-top:1px solid var(--qqj-inline-line);padding-top:10px}
    .time-progression>summary{cursor:pointer;font-size:11px;font-weight:600;list-style-position:inside}
    .time-progression:not([open])>.time-progression-list{display:none}
    .time-progression-list{display:grid;gap:10px;margin-top:9px}
    .time-progression-item{padding:9px 10px;border-radius:6px;background:var(--soft)}
    .time-progression-subject{display:block;font-size:11px;margin-bottom:3px}
    .time-progression-copy,.time-progression-meta{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
    .time-progression-copy{font-size:11px;line-height:1.85}
    .time-progression-meta{font-size:9.5px;color:var(--muted);margin-top:4px}
    .people-current{border:1px solid var(--qqj-inline-line);border-radius:7px;padding:11px 12px;background:var(--soft)}
    .section-heading{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:600;margin:0 0 9px}
    .section-heading::before{content:'';height:10px;width:2px;background:var(--qqj-inline-knot);border-radius:1px}
    .current-person{padding:8px 0;border-top:1px solid var(--qqj-inline-line)}
    .current-name{display:block;font-size:11px;font-weight:650;margin:0 0 3px}
    .current-copy{margin:0;font-size:11px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere}
    .current-copy+.current-copy{margin-top:4px}
    .people-history{margin-top:19px}
    .person-picker{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
    .person-pill{display:flex;gap:6px;align-items:center;max-width:100%;border:1px solid transparent;border-radius:5px;background:none;padding:4px 9px;font-size:11px!important}
    .person-pill[aria-pressed=true]{background:var(--soft);border-color:var(--qqj-inline-line);font-weight:600}
    .person-count{color:var(--muted);font-size:10px;font-weight:400}
    .change-timeline{padding-left:7px}
    .change-floor{position:relative;border-left:1px solid var(--qqj-inline-line);padding:0 0 16px 15px}
    .change-floor:last-child{padding-bottom:3px}
    .change-floor::before{content:'';position:absolute;left:-3px;top:9px;width:5px;height:5px;border-radius:50%;background:var(--qqj-inline-knot)}
    .change-floor>summary{list-style:none;cursor:pointer;font-size:10.5px;color:var(--muted);padding:0 0 7px;display:flex;align-items:center;gap:7px}
    .change-floor>summary::-webkit-details-marker{display:none}
    .change-floor>summary::after{content:'＋';margin-left:auto;font-size:11px}
    .change-floor[open]>summary::after{content:'−'}
    .change-count{opacity:.65;font-size:10px}
    .change-entry+.change-entry{margin-top:10px}
    .change-layer{font-size:9px;color:var(--muted);margin-bottom:2px}
    .change-row{display:grid;grid-template-columns:12px minmax(0,1fr);gap:5px;padding:2px 0;font-size:11px;line-height:1.8}
    .change-sign{font-size:14px;line-height:1.4;font-weight:600;user-select:none}
    .change-added .change-sign{color:light-dark(#277a4b,#79bd94)}
    .change-removed{color:var(--muted)}
    .change-removed .change-copy{text-decoration:line-through;text-decoration-thickness:1px}
    .change-copy{white-space:pre-wrap;overflow-wrap:anywhere}
    .change-visibility{font-size:9px;color:var(--muted);margin-left:6px;white-space:nowrap}
  `;
  if (!card.recallStyle) { card.root.append(style); card.recallStyle = style; }
  const root = node('div', 'recall-design');
  const tabs = node('div', 'recall-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '召回内容');
  const eventTab = button('recall-tab', '事'), peopleTab = button('recall-tab', '人');
  const events = node('section'), people = node('section');
  const prefix = `recall-${card.host.dataset.messageId}`;
  for (const [tab, panel, key] of [[eventTab, events, 'events'], [peopleTab, people, 'people']]) {
    tab.id = `${prefix}-${key}-tab`; panel.id = `${prefix}-${key}`;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
  }
  const selectTab = selected => {
    state.tab = selected === eventTab ? 'events' : 'people';
    for (const [tab, panel] of [[eventTab, events], [peopleTab, people]]) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; panel.hidden = !active;
    }
  };
  for (const tab of [eventTab, peopleTab]) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? eventTab : event.key === 'End' ? peopleTab : tab === eventTab ? peopleTab : eventTab;
      selectTab(target); target.focus();
    });
  }
  tabs.append(eventTab, peopleTab); root.append(tabs, events, people); selectTab(state.tab === 'people' ? peopleTab : eventTab);
  const floorLabel = floorId => {
    const value = sources.get(floorId);
    return Number.isSafeInteger(value) ? `第 ${value} 个结` : '来源结号未提供';
  };
  const eventGroups = new Map();
  const lines = projection.storylineGroups?.length ? projection.storylineGroups : [{ title:'', floors:projection.historyGroups ?? [] }];
  for (const line of lines) for (const floor of line.floors) {
    const key = floor.floorId || `sequence-${floor.assistantSeq}`;
    if (!eventGroups.has(key)) eventGroups.set(key, { ...floor, items:[], titles:[] });
    const group = eventGroups.get(key);
    for (const item of floor.items) if (!group.items.some(other => other.text === item.text)) group.items.push(item);
    if (line.title && !group.titles.includes(line.title)) group.titles.push(line.title);
  }
  const pills = node('div', 'event-pills'), display = node('div', 'event-display is-empty');
  display.id = `${prefix}-event-content`; display.setAttribute('role', 'region'); display.setAttribute('aria-label', '所选旧事'); display.setAttribute('aria-live', 'polite');
  const emptyEvents = () => display.replaceChildren(node('p', 'recall-empty', eventGroups.size ? '点一个结，看看那时的事。' : projection.summary || '本轮没有召回旧事。'));
  let selectedEvent = eventGroups.has(state.event) ? state.event : null;
  state.event = selectedEvent;
  const eventButtons = [];
  const showEvent = () => {
    for (const pill of eventButtons) pill.setAttribute('aria-expanded', String(pill.dataset.eventKey === selectedEvent));
    display.className = 'event-display' + (selectedEvent === null ? ' is-empty' : '');
    if (selectedEvent === null) { emptyEvents(); return; }
    const floor = eventGroups.get(selectedEvent);
    display.replaceChildren(node('p', 'event-caption', [floorLabel(floor.floorId), ...floor.titles].join(' · ')), ...floor.items.map(item => node('p', 'event-copy', item.text)));
  };
  for (const [key, floor] of eventGroups) {
    const pill = button('event-pill', floorLabel(floor.floorId));
    pill.dataset.eventKey = key;
    pill.setAttribute('aria-expanded', 'false'); pill.setAttribute('aria-controls', display.id);
    eventButtons.push(pill);
    pill.addEventListener('click', () => {
      selectedEvent = selectedEvent === key ? null : key;
      state.event = selectedEvent;
      showEvent();
    });
    pills.append(pill);
  }
  showEvent(); events.append(pills, display);
  if (projection.stateProgressionItems?.length) {
    const progression = node('details', 'time-progression');
    progression.append(node('summary', '', '时间推演'));
    const list = node('div', 'time-progression-list');
    const progressionVisibility = { private:'仅本人知晓', observable:'可观察', expressed:'已表达', shared:'已共享', authorial:'作者视角' };
    for (const item of projection.stateProgressionItems) {
      const entry = node('article', 'time-progression-item');
      entry.append(node('strong', 'time-progression-subject', `${item.subject}${item.toward ? ` → ${item.toward}` : ''} · 原记录：${progressionVisibility[item.visibility] ?? item.visibility}`));
      entry.append(node('p', 'time-progression-copy', `保存时：${item.savedText}\n此刻表现建议：${item.suggestion}`));
      const evidenceLabels = [...new Set((item.evidence ?? []).map(value => value.floorId ? floorLabel(value.floorId) : null).filter(Boolean))];
      entry.append(node('p', 'time-progression-meta', `${item.timeBasis} · 状态${floorLabel(item.sourceFloorId)}${evidenceLabels.length ? ` · 依据 ${evidenceLabels.join('、')}` : ''} · 作者侧续写表现建议，不表示任何角色已知，也并非新剧情事实`));
      list.append(entry);
    }
    progression.append(list); events.append(progression);
  }

  const identity = value => value.subjectEntityId || `name:${value.subject}`;
  const statesByPerson = new Map();
  for (const state of projection.stateItems ?? []) {
    const id = identity(state);
    if (!statesByPerson.has(id)) statesByPerson.set(id, { name:state.subject, items:[] });
    const items = statesByPerson.get(id).items;
    if (!items.some(item => item.text === state.text && item.toward === state.toward && item.layer === state.layer)) items.push(state);
  }
  const current = node('section', 'people-current'); current.append(node('h3', 'section-heading', '人物当前状态'));
  for (const person of statesByPerson.values()) {
    const group = node('div', 'current-person'); group.append(node('strong', 'current-name', person.name));
    for (const item of person.items) group.append(node('p', 'current-copy', `${item.toward ? `→ ${item.toward}：` : ''}${item.text}`));
    current.append(group);
  }
  if (!statesByPerson.size) current.append(node('p', 'recall-empty', '本轮未召回人物当前状态。'));
  const history = node('section', 'people-history'); history.append(node('h3', 'section-heading', '人物变化'));
  const changesByPerson = new Map();
  for (const change of projection.cseChangeItems ?? []) {
    const id = identity(change);
    if (!changesByPerson.has(id)) changesByPerson.set(id, { name:change.subject, floors:new Map(), seen:new Set() });
    const person = changesByPerson.get(id);
    const signature = JSON.stringify([change.floorId, change.assistantSeq, change.layer, change.action, change.before, change.after]);
    if (person.seen.has(signature)) continue;
    person.seen.add(signature);
    const key = change.floorId || `sequence-${change.assistantSeq}`;
    if (!person.floors.has(key)) person.floors.set(key, { floorId:change.floorId, sequence:change.assistantSeq, items:[] });
    person.floors.get(key).items.push(change);
  }
  const picker = node('div', 'person-picker'); picker.setAttribute('role', 'group'); picker.setAttribute('aria-label', '查看人物变化');
  const timelines = node('div');
  const personViews = [];
  const layerLabels = {core:'核心', adaptive:'适应', situational:'情境'};
  const visibilityLabels = {private:'仅本人知晓', observable:'可观察', expressed:'已表达', shared:'已共享', authorial:'作者视角'};
  for (const [personId, person] of changesByPerson) {
    const pill = button('person-pill', person.name); pill.append(node('span', 'person-count', `${person.floors.size} 楼`));
    const timeline = node('div', 'change-timeline');
    for (const [floorKey, floor] of [...person.floors].sort((a,b) => b[1].sequence - a[1].sequence)) {
      const detail = node('details', 'change-floor');
      const stateKey = JSON.stringify([personId, floorKey]);
      detail.open = state.floors.get(stateKey) === true;
      detail.addEventListener('toggle', () => state.floors.set(stateKey, detail.open === true));
      const heading = node('summary', '', floorLabel(floor.floorId)); heading.append(node('span', 'change-count', `${floor.items.length} 条`)); detail.append(heading);
      for (const item of floor.items) {
        const entry = node('div', 'change-entry');
        if (item.layer !== 'situational') entry.append(node('div', 'change-layer', layerLabels[item.layer] || item.layer));
        const addRow = (value, removed) => {
          if (!value?.text) return;
          const row = node('div', `change-row ${removed ? 'change-removed' : 'change-added'}`);
          const sign = node('span', 'change-sign', removed ? '−' : '+'); sign.setAttribute('role', 'img'); sign.setAttribute('aria-label', removed ? '删除' : '新增');
          const copy = node(removed ? 'del' : 'span', 'change-copy', value.text);
          const content = node('div'); content.append(copy);
          if (visibilityLabels[value.visibility]) content.append(node('span', 'change-visibility', visibilityLabels[value.visibility]));
          row.append(sign, content); entry.append(row);
        };
        if (item.action !== 'add') addRow(item.before, true);
        if (item.action !== 'remove') addRow(item.after, false);
        detail.append(entry);
      }
      timeline.append(detail);
    }
    personViews.push({ personId, pill, timeline }); picker.append(pill); timelines.append(timeline);
    pill.addEventListener('click', () => {
      state.person = personId;
      for (const view of personViews) { const active = view.pill === pill; view.pill.setAttribute('aria-pressed', String(active)); view.timeline.hidden = !active; }
    });
  }
  if (personViews.length) (personViews.find(view => view.personId === state.person) ?? personViews[0]).pill.click();
  else timelines.append(node('p', 'recall-empty', '本轮未召回人物变化。'));
  history.append(picker, timelines); people.append(current, history);
  card.body.replaceChildren(root);
  card.recallUi = { root, eventTab, peopleTab, events, people, pills, display, current, history, picker, timelines };
}
