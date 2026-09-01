import { ARCHIVE_V2_BOND_FIELD_KEYS, ARCHIVE_V2_BOND_STAGES } from '../archive-v2-bond-foundation.js';

export const ARCHIVE_V2_BOND_FIELD_LABELS = Object.freeze({
  stage: '当前关系阶段',
  cView: 'C 对 U · 看法',
  cEmotion: 'C 对 U · 情绪',
  cDesire: 'C 对 U · 欲望',
  cGoal: 'C 对 U · 目标',
  cConcern: 'C 对 U · 顾虑',
  cSecret: 'C 对 U · 秘密',
  uView: 'U 对 C · 看法',
  uEmotion: 'U 对 C · 情绪',
  uPlan: 'U 对 C · 计划',
  uBoundary: 'U 对 C · 边界',
  uExpectation: 'U 对 C · 期待',
  recentChanges: '最近变化',
});

const TARGETS = Object.freeze({
  stage: ['stage'],
  cView: ['cToU', 'view'],
  cEmotion: ['cToU', 'emotion'],
  cDesire: ['cToU', 'desire'],
  cGoal: ['cToU', 'goal'],
  cConcern: ['cToU', 'concern'],
  cSecret: ['cToU', 'secret'],
  uView: ['uToC', 'view'],
  uEmotion: ['uToC', 'emotion'],
  uPlan: ['uToC', 'plan'],
  uBoundary: ['uToC', 'boundary'],
  uExpectation: ['uToC', 'expectation'],
  recentChanges: ['recentChanges'],
});

function bondField(bond, field) {
  const target = TARGETS[field];
  return target.length === 1 ? bond?.[target[0]] : bond?.[target[0]]?.[target[1]];
}

function displayName(person) {
  const value = person?.displayName?.value;
  return typeof value === 'string' && value.trim() ? value.trim() : '未命名人物';
}

const BOND_STAGE_SET = new Set(ARCHIVE_V2_BOND_STAGES);

function stateCopy(state) {
  const status = state?.status;
  if (status === 'error') return ['双丝网没有完成', state?.errorDetail || '任一批失败都不会部分写入正式档案，可以重新生成。'];
  return {
    uninitialized: ['尚未建立千人档案', '请先在“千人”完成历史初始化并确认关注人物。'],
    empty: ['当前没有关注人物', '请先在“千人”的因缘簿中设置至少一位关注人物。'],
    persona_mismatch: ['当前 Persona 与建档 Persona 不一致', '旧档案仍可查看，但本次不会生成或保存双丝网。'],
    memory_not_ready: ['历史记忆尚未完成', '请先在“千人”完成历史扫描与人物整理。'],
    people_missing: ['人物整理结果不可用', '请先回到“千人”重新确认人物整理结果。'],
    source_changed: ['历史来源已经变化', '本次没有保存；请先确认当前聊天初始化状态。'],
    conflict: ['档案已在别处变化', '本次草稿没有覆盖现有档案，请重新生成。'],
    stale: ['当前聊天或 Persona 已变化', '迟到结果不会保存。'],
    disabled: ['千千结当前已关闭', '已有档案保持不变。'],
  }[status] ?? ['双丝网暂时不可用', '已有档案保持不变。'];
}

const SOURCE_DETAIL_LIMIT = 120;

function bondSourceRefs(bond) {
  const output = [];
  const seen = new Set();
  const add = refs => {
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (output.length >= SOURCE_DETAIL_LIMIT) return;
      if (!ref || typeof ref !== 'object') continue;
      const kind = typeof ref.kind === 'string' ? ref.kind.trim() : '';
      const locator = typeof ref.locator === 'string' ? ref.locator.trim() : '';
      if (!kind || !locator) continue;
      const key = `${kind}\u0000${locator}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({ kind, locator });
    }
  };
  add(bond?.sourceRefs);
  for (const field of ARCHIVE_V2_BOND_FIELD_KEYS) add(bondField(bond, field)?.sourceRefs);
  for (const signal of Array.isArray(bond?.nativeSignals) ? bond.nativeSignals : []) add(signal?.sourceRefs);
  return output;
}

export function createArchiveV2BondView({ composition, documentRef = globalThis.document, sourcePermissions, sourcePermissionView, onOpenSourceSettings } = {}) {
  for (const [value, label] of [
    [composition?.inspect, 'composition.inspect'],
    [composition?.generate, 'composition.generate'],
    [composition?.commit, 'composition.commit'],
    [composition?.getState, 'composition.getState'],
  ]) if (typeof value !== 'function') throw new TypeError(`${label} 必须是函数`);
  if (!documentRef?.createElement) throw new TypeError('documentRef 无效');

  let root = null;
  let active = false;
  let destroyed = false;
  let epoch = 0;
  let state = { status: 'idle' };
  let busy = false;
  let progressTimer = null;
  let validationMessage = '';
  const edits = new Map();
  let focusedIdentityId = '';
  let pendingPreflight = false;
  const clock = documentRef.defaultView ?? globalThis;

  function stopProgress() {
    if (progressTimer !== null) clock.clearInterval?.(progressTimer);
    progressTimer = null;
  }

  function startProgress() {
    stopProgress();
    progressTimer = clock.setInterval?.(() => {
      if (!active || !busy) return;
      const next = composition.getState();
      if (next?.status === 'running') {
        state = next;
        render();
      }
    }, 120) ?? null;
  }

  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  };
  const button = (text, className, handler, disabled = false) => {
    const node = element('button', className, text);
    node.type = 'button';
    node.disabled = disabled;
    node.addEventListener('click', () => { if (!node.disabled) handler(); });
    return node;
  };

  function orderedFollowed(archive) {
    const order = Array.isArray(archive?.people?.order) ? archive.people.order : [];
    return order.map(identityId => archive.people.byId?.[identityId]).filter(person => person?.followed === true);
  }

  function renderHeading(title, copy) {
    const heading = element('header', 'bond-heading');
    heading.append(element('h2', '', title), element('p', '', copy));
    return heading;
  }

  function renderSwitcher(people) {
    if (!people.length) return null;
    if (!people.some(person => person.identityId === focusedIdentityId)) focusedIdentityId = people[0].identityId;
    const rail = element('nav', 'bond-person-switcher');
    rail.setAttribute('aria-label', '切换双丝网人物');
    for (const person of people) {
      const tab = button(displayName(person), `bond-person-tab${person.identityId === focusedIdentityId ? ' active' : ''}`, () => { focusedIdentityId = person.identityId; render(); });
      tab.setAttribute('aria-current', person.identityId === focusedIdentityId ? 'true' : 'false');
      rail.append(tab);
    }
    return rail;
  }

  function focusedPerson(people) {
    if (!people.length) return null;
    if (!people.some(person => person.identityId === focusedIdentityId)) focusedIdentityId = people[0].identityId;
    return people.find(person => person.identityId === focusedIdentityId) ?? people[0];
  }

  function appendFocusedArchive(page, archive) {
    const people = orderedFollowed(archive);
    const switcher = renderSwitcher(people);
    if (switcher) page.append(switcher);
    const person = focusedPerson(people);
    if (!person) return;
    const bond = archive?.bonds?.[person.identityId];
    if (bond) page.append(renderBondCard(person, bond));
    else {
      const card = element('article', 'bond-card');
      card.append(element('h3', '', displayName(person)), element('p', 'layer-empty', '该人物尚未建立双丝网。'));
      page.append(card);
    }
  }

  function renderPendingPreflight() {
    if (!pendingPreflight || !sourcePermissionView) return null;
    return sourcePermissionView.renderPreflight({
      onOpenSettings: onOpenSourceSettings,
      onContinue: () => { sourcePermissions.confirmCurrent(); pendingPreflight = false; generate(); },
    });
  }

  function renderStageAxis(person, bond, stageValue) {
    const stage = typeof stageValue === 'string' ? stageValue.trim() : '';
    const standard = BOND_STAGE_SET.has(stage);
    const axis = element('section', `bond-stage-axis${stage ? '' : ' missing'}${stage && !standard ? ' legacy-stage' : ''}`);
    axis.setAttribute('aria-label', `U 与 ${displayName(person)} 的五阶段关系轴`);
    const caption = element('div', 'bond-stage-caption');
    caption.append(element('strong', '', 'U ↔ C'), element('small', '', `与 ${displayName(person)} 的关系阶段`));
    const track = element('ol', 'bond-stage-track');
    for (const label of ARCHIVE_V2_BOND_STAGES) {
      const step = element('li', `bond-stage-step${label === stage ? ' active' : ''}`);
      if (label === stage) step.setAttribute('aria-current', 'step');
      step.append(element('span', 'bond-stage-dot'), element('strong', '', label));
      track.append(step);
    }
    axis.append(caption, track);
    if (stage && !standard) {
      const legacy = element('p', 'bond-legacy-stage-value');
      legacy.append(element('small', '', '旧档案阶段原文'), element('strong', '', stage));
      axis.append(legacy);
    }
    return axis;
  }

  function renderBondCard(person, bond, { draft = false } = {}) {
    const card = element('article', 'bond-card');
    const heading = element('div', 'bond-person-heading');
    heading.append(element('span', 'subject-tag tag-u', 'U'), element('span', 'bond-link-mark', '↔'), element('span', 'subject-tag tag-c', 'C'), element('h3', '', displayName(person)));
    card.append(heading);
    if (draft) {
      const stageKey = `${person.identityId}\u0000stage`;
      const draftStage = edits.has(stageKey) ? edits.get(stageKey) : String(bondField(bond, 'stage')?.value ?? '');
      card.append(renderStageAxis(person, bond, draftStage));
      for (const field of ARCHIVE_V2_BOND_FIELD_KEYS) {
        const row = element('label', `bond-edit-field${field === 'stage' ? ' stage-edit' : ''}`);
        row.append(element('span', '', ARCHIVE_V2_BOND_FIELD_LABELS[field]));
        const input = element(field === 'stage' ? 'select' : 'textarea');
        const key = `${person.identityId}\u0000${field}`;
        const currentValue = edits.has(key) ? edits.get(key) : String(bondField(bond, field)?.value ?? '');
        if (field === 'stage') {
          if (!BOND_STAGE_SET.has(currentValue)) {
            const placeholder = element('option', '', '请选择固定阶段');
            placeholder.value = '';
            placeholder.disabled = true;
            input.append(placeholder);
          }
          for (const stage of ARCHIVE_V2_BOND_STAGES) {
            const option = element('option', '', stage);
            option.value = stage;
            input.append(option);
          }
        }
        input.value = BOND_STAGE_SET.has(currentValue) || field !== 'stage' ? currentValue : '';
        input.dataset ||= {};
        input.dataset.identityId = person.identityId;
        input.dataset.field = field;
        input.addEventListener(field === 'stage' ? 'change' : 'input', () => {
          edits.set(key, input.value);
          validationMessage = '';
          if (field === 'stage') render();
        });
        row.append(input);
        card.append(row);
      }
      const signals = element('div', 'bond-signals');
      signals.append(element('strong', '', '将保存的作者原生关系信息（只读）'));
      if (Array.isArray(bond?.nativeSignals) && bond.nativeSignals.length) {
        for (const signal of bond.nativeSignals) {
          signals.append(element('span', 'bond-signal', `${signal.label}：${String(signal.value)}`));
        }
      } else signals.append(element('span', 'layer-empty', '本卡没有作者原生关系信息，千千结不伪造分数或标签'));
      card.append(signals);
      card.append(element('small', 'bond-floor', bond?.updatedThroughFloor === null
        ? '将保存的截止楼层：尚无稳定 AI 正文（只读）'
        : `将保存的截止楼层：${bond.updatedThroughFloor}（只读）`));
    } else {
      const stage = bondField(bond, 'stage')?.value;
      const legacyStage = typeof stage === 'string' && stage.trim() && !BOND_STAGE_SET.has(stage.trim());
      card.append(renderStageAxis(person, bond, stage));
      if (legacyStage) card.append(element('p', 'bond-legacy-stage-note', '这是旧档案保存的阶段原文；标准五阶段轴不会伪造高亮，也不会自动改写或调用 AI。'));
      if (Array.isArray(bond?.nativeSignals) && bond.nativeSignals.length) {
        const signals = element('div', 'bond-signals');
        signals.append(element('strong', '', '作者原生关系信息（只读）'));
        for (const signal of bond.nativeSignals) {
          signals.append(element('span', 'bond-signal', `${signal.label}：${String(signal.value)}`));
        }
        card.append(signals);
      } else card.append(element('p', 'bond-no-native', '本卡没有作者原生关系信息，千千结不伪造分数或标签'));
      const weave = element('section', 'bond-weave');
      const sides = [];
      for (const [title, className, fields] of [
        ['U → C', 'side-u', ['uView', 'uEmotion', 'uPlan', 'uBoundary', 'uExpectation']],
        ['C → U', 'side-c', ['cView', 'cEmotion', 'cDesire', 'cGoal', 'cConcern', 'cSecret']],
      ]) {
        const side = element('section', `bond-side bond-weave-side ${className}`);
        side.append(element('strong', '', title));
        let count = 0;
        for (const field of fields) {
          const value = bondField(bond, field)?.value;
          if (!value) continue;
          count += 1;
          side.append(element('p', '', `${ARCHIVE_V2_BOND_FIELD_LABELS[field].split('·').at(-1).trim()}：${value}`));
        }
        if (!count) side.append(element('p', 'layer-empty', '暂无有据可依的内容。'));
        sides.push(side);
      }
      const changes = bondField(bond, 'recentChanges')?.value;
      const central = element('div', 'bond-central-thread');
      central.setAttribute('aria-hidden', 'true');
      central.append(element('span', 'bond-central-line'), element('span', 'bond-central-knot'));
      const recent = element('section', 'bond-recent bond-weave-recent');
      recent.append(element('strong', '', '最近变化'), element('p', changes || '暂无有据可依的变化。'));
      weave.append(sides[0], central, sides[1], recent);
      card.append(weave);
      const details = element('details', 'bond-secondary-sources'); details.append(element('summary', '', '来源与截止楼层'));
      const sourceRefs = bondSourceRefs(bond);
      details.append(element('small', 'bond-floor', bond?.updatedThroughFloor === null ? '截止楼层：尚无稳定 AI 正文' : `截止楼层：${bond.updatedThroughFloor}`));
      if (sourceRefs.length) details.append(element('p', 'bond-source-ids', sourceRefs.map(ref => `${ref.kind} · ${ref.locator}`).join('\n')));
      else details.append(element('p', 'bond-source-ids layer-empty', '暂无可展示的来源摘要。'));
      card.append(details);
    }
    return card;
  }

  function renderReady() {
    const page = element('section', 'bond-page');
    page.append(renderHeading('首次建立双丝网', '读取稳定 AI 历史、人物来源与只读原生信号；生成草稿后由你确认保存。'));
    const preflight = renderPendingPreflight();
    if (preflight) page.append(preflight);
    else page.append(button('建立双丝网', 'primary-action', requestGenerate, busy || state.followedCount < 1));
    if (state.archive) appendFocusedArchive(page, state.archive);
    return page;
  }

  function renderRunning() {
    const page = element('section', 'bond-page');
    const progress = state.totalBatches > 0 ? `正在处理第 ${state.batchIndex} / ${state.totalBatches} 批` : '正在准备来源';
    page.append(renderHeading('正在建立双丝网', `${progress}；每批最多四人，全部成功前不会写入正式档案。`));
    return page;
  }

  function renderDraft() {
    const page = element('section', 'bond-page');
    page.append(renderHeading('双丝网草稿', '可以修改文字；你改过的字段保存后会成为用户保护内容。'));
    const people = state.draft.people.map(item => ({ identityId: item.identityId, displayName: { value: item.displayName }, bond: item.bond }));
    const switcher = renderSwitcher(people); if (switcher) page.append(switcher);
    const person = focusedPerson(people);
    if (person) page.append(renderBondCard(person, person.bond, { draft: true }));
    if (validationMessage) page.append(element('p', 'bond-validation-error', validationMessage));
    page.append(button('确认并保存双丝网', 'primary-action', commit, busy));
    return page;
  }

  function renderSaved() {
    const page = element('section', 'bond-page');
    page.append(renderHeading('双丝网', '已保存的关系摘要；打开档案本身不会调用 AI。'));
    appendFocusedArchive(page, state.archive);
    return page;
  }

  function renderTerminal() {
    const [title, copy] = stateCopy(state);
    const page = element('section', 'bond-page');
    page.append(renderHeading(title, copy));
    const preflight = renderPendingPreflight();
    if (preflight) page.append(preflight);
    else if (['error', 'conflict', 'source_changed'].includes(state.status)) page.append(button('重新生成', 'primary-action', requestGenerate, busy));
    if (state.archive) appendFocusedArchive(page, state.archive);
    return page;
  }

  function render() {
    if (!root || !active || destroyed) return;
    root.setAttribute('aria-busy', String(busy));
    let content;
    if (state.status === 'ready') content = renderReady();
    else if (state.status === 'running' || state.status === 'saving') content = renderRunning();
    else if (state.status === 'draft') content = renderDraft();
    else if (state.status === 'saved') content = renderSaved();
    else content = renderTerminal();
    root.replaceChildren(content);
  }

  function generate() {
    if (busy) return;
    const token = epoch;
    busy = true;
    state = { ...composition.getState(), status: 'running' };
    render();
    startProgress();
    Promise.resolve(composition.generate()).then(result => {
      if (!active || token !== epoch) return;
      stopProgress();
      busy = false;
      state = result ?? composition.getState();
      edits.clear();
      validationMessage = '';
      render();
    }, () => {
      if (!active || token !== epoch) return;
      stopProgress();
      busy = false;
      state = composition.getState();
      render();
    });
  }

  function requestGenerate() {
    if (sourcePermissions && !sourcePermissions.isCurrentConfirmed()) {
      pendingPreflight = true;
      render();
      return;
    }
    generate();
  }

  function commit() {
    if (busy) return;
    if ([...edits.values()].some(value => typeof value !== 'string' || !value.trim())) {
      validationMessage = '字段不能清空保存；如不修改，请保留草稿原文。';
      render();
      return;
    }
    const invalidStagePerson = state.draft?.people?.find(person => {
      const key = `${person.identityId}\u0000stage`;
      const value = edits.has(key) ? edits.get(key) : bondField(person.bond, 'stage')?.value;
      return !BOND_STAGE_SET.has(String(value ?? '').trim());
    });
    if (invalidStagePerson) {
      focusedIdentityId = invalidStagePerson.identityId;
      validationMessage = `请先为${String(invalidStagePerson.displayName || '该人物')}选择固定关系阶段。`;
      render();
      return;
    }
    const token = epoch;
    const payload = {};
    for (const [key, value] of edits) {
      const [identityId, field] = key.split('\u0000');
      (payload[identityId] ||= {})[field] = value;
    }
    busy = true;
    state = { ...composition.getState(), status: 'saving' };
    render();
    Promise.resolve(composition.commit({ edits: payload })).then(result => {
      if (!active || token !== epoch) return;
      busy = false;
      state = result?.archive ? { ...composition.getState(), archive: result.archive } : composition.getState();
      edits.clear();
      validationMessage = '';
      render();
    }, () => {
      if (!active || token !== epoch) return;
      busy = false;
      state = composition.getState();
      render();
    });
  }

  function mount(container) {
    if (destroyed || !container?.append) throw new TypeError('双丝网挂载容器无效');
    root?.remove?.();
    root = element('section', 'archive-v2-bonds');
    container.append(root);
    return root;
  }

  async function activate() {
    if (!root || destroyed) throw new TypeError('双丝网视图尚未挂载');
    active = true;
    pendingPreflight = false;
    root.hidden = false;
    const token = ++epoch;
    busy = true;
    render();
    try { state = await composition.inspect(); }
    catch { state = composition.getState(); }
    if (active && token === epoch) {
      busy = false;
      render();
    }
    return state;
  }

  function deactivate() {
    if (!root || destroyed) return;
    active = false;
    epoch += 1;
    busy = false;
    stopProgress();
    root.hidden = true;
  }

  function destroy() {
    if (destroyed) return;
    deactivate();
    destroyed = true;
    root?.remove?.();
    root = null;
  }

  return Object.freeze({ mount, activate, deactivate, destroy });
}
