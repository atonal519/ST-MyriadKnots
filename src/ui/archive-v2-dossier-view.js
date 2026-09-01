import { ARCHIVE_V2_DOSSIER_FIELD_KEYS } from '../archive-v2-dossier-composition.js';

export const ARCHIVE_V2_DOSSIER_FIELD_LABELS = Object.freeze({
  gender: '性别',
  age: '年龄',
  appearance: '外貌',
  personality: '性格',
  identity: '身份',
  abilities: '能力',
  likes: '喜欢',
  dislikes: '讨厌',
  principles: '原则',
  relationships: '关系',
  nsfwPreferences: '亲密偏好',
});

const SOURCE_LABELS = Object.freeze({
  card: '角色卡',
  greeting: '开场白',
  worldbook: '世界书',
  chat: '历史记忆',
});

const RAIL_LIMIT = 4;

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} 必须是函数`);
}

function displayName(person) {
  const value = person?.displayName?.value;
  return typeof value === 'string' && value.trim() ? value.trim() : '未命名人物';
}

function followed(person) {
  return person?.followed === true;
}

export function archiveV2DossierSourceLabel(ownership) {
  if (ownership?.origin === 'user' || ownership?.userProtected === true) return '用户填写';
  const labels = [];
  for (const ref of Array.isArray(ownership?.sourceRefs) ? ownership.sourceRefs : []) {
    const label = SOURCE_LABELS[ref?.kind];
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels.join('·') || '来源未记录';
}

function statusCopy(status) {
  return {
    conflict: '档案已在其他操作中变化，本次没有覆盖。',
    stale: '当前聊天已经变化，迟到结果不会保存。',
    disabled: '千千结当前未启用，本次没有保存。',
    busy: '另一项档案操作尚未完成。',
    error: '操作没有完成，原档案保持不变。',
  }[status] ?? '操作没有完成，原档案保持不变。';
}

export function createArchiveV2DossierView({ actions, documentRef = globalThis.document } = {}) {
  for (const [value, label] of [
    [actions?.updatePerson, 'actions.updatePerson'],
    [actions?.renamePerson, 'actions.renamePerson'],
    [actions?.setFollowed, 'actions.setFollowed'],
  ]) requireFunction(value, label);
  if (!documentRef || typeof documentRef.createElement !== 'function') throw new TypeError('documentRef 必须能创建元素');

  let selectedIdentityId = null;
  let contentMode = 'dossier';
  let editing = false;
  let operationBusy = false;
  let message = null;
  let epoch = 0;
  let model = null;
  const editDraft = new Map();
  const fateNameDrafts = new Map();

  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  };
  const button = (label, className, handler, disabled = false) => {
    const node = element('button', className, label);
    node.type = 'button';
    node.disabled = disabled;
    node.addEventListener('click', () => { if (!node.disabled) handler(); });
    return node;
  };
  const requestRender = () => {
    try { model?.requestRender?.(); } catch { /* parent view owns rendering */ }
  };

  function orderedPeople() {
    const archive = model?.readResult?.archive;
    const order = Array.isArray(archive?.people?.order) ? archive.people.order : [];
    return order.map(identityId => archive.people.byId?.[identityId]).filter(Boolean);
  }

  function syncSelection(people) {
    const active = people.filter(followed);
    if (!active.some(person => person.identityId === selectedIdentityId)) {
      selectedIdentityId = active[0]?.identityId ?? null;
      editing = false;
      editDraft.clear();
    }
    if (!selectedIdentityId && contentMode === 'dossier') contentMode = 'fateBook';
    return active;
  }

  function runAction(action, successText, onSuccess = () => {}) {
    if (operationBusy || model?.busy) return;
    const token = epoch;
    operationBusy = true;
    message = { kind: 'info', text: '正在使用档案 revision 安全保存…' };
    requestRender();
    Promise.resolve().then(action).then(result => {
      if (token !== epoch) return;
      operationBusy = false;
      if (['saved', 'ready'].includes(result?.status)) {
        message = { kind: 'success', text: result.changed === false ? '内容没有变化。' : successText };
        onSuccess(result);
        if (result.archive) model?.onArchiveChange?.(result);
      } else {
        message = { kind: 'error', text: statusCopy(result?.status) };
      }
      requestRender();
    }, () => {
      if (token !== epoch) return;
      operationBusy = false;
      message = { kind: 'error', text: statusCopy('error') };
      requestRender();
    });
  }

  function renderSource(ownership) {
    return element('small', 'basic-source', archiveV2DossierSourceLabel(ownership));
  }

  function renderField(key, ownership) {
    const card = element('div', 'basic-field');
    card.append(element('span', 'basic-label', ARCHIVE_V2_DOSSIER_FIELD_LABELS[key]));
    if (editing) {
      const input = element(['gender', 'age', 'identity'].includes(key) ? 'input' : 'textarea');
      input.value = editDraft.has(key) ? editDraft.get(key) : String(ownership?.value ?? '');
      input.dataset.field = key;
      input.addEventListener('input', () => editDraft.set(key, input.value));
      card.append(input);
    } else {
      const value = typeof ownership?.value === 'string' ? ownership.value : '';
      card.append(element('p', `basic-value${value ? '' : ' missing'}`, value || '未提及'));
      card.append(renderSource(ownership));
    }
    return card;
  }

  function renderBasicInfo(person) {
    const section = element('section', 'basic-info');
    const head = element('div', 'basic-info-head');
    const copy = element('div');
    copy.append(element('h3', '', '基础信息'), element('p', '', '姓名与 11 项基础人设；用户修改会被保护。'));
    const actionsBox = element('div', editing ? 'basic-edit-actions' : 'basic-info-actions');
    const disabled = operationBusy || model?.busy;
    if (!editing) {
      actionsBox.append(button('编辑', 'secondary-action', () => {
        editing = true;
        message = null;
        editDraft.clear();
        editDraft.set('displayName', displayName(person));
        for (const key of ARCHIVE_V2_DOSSIER_FIELD_KEYS) editDraft.set(key, String(person.fields?.[key]?.value ?? ''));
        requestRender();
      }, disabled));
    } else {
      actionsBox.append(
        button('保存修改', 'primary-action', () => {
          const nextName = (editDraft.get('displayName') ?? displayName(person)).trim();
          if (!nextName) {
            message = { kind: 'error', text: '人物姓名不能为空。' };
            requestRender();
            return;
          }
          const fields = Object.fromEntries(ARCHIVE_V2_DOSSIER_FIELD_KEYS
            .map(key => [key, editDraft.get(key) ?? ''])
            .filter(([key, value]) => String(person.fields?.[key]?.value ?? '') !== value));
          runAction(
            () => actions.updatePerson({
              identityId: person.identityId,
              ...(nextName !== displayName(person) ? { displayName: nextName } : {}),
              fields,
            }),
            '基础信息已保存。',
            () => { editing = false; editDraft.clear(); },
          );
        }, disabled),
        button('取消', 'secondary-action', () => { editing = false; editDraft.clear(); message = null; requestRender(); }, disabled),
      );
    }
    head.append(copy, actionsBox);
    section.append(head);
    const fields = element('div', 'basic-fields');
    const nameCard = element('div', 'basic-field');
    nameCard.append(element('span', 'basic-label', '姓名'));
    if (editing) {
      const input = element('input');
      input.value = editDraft.get('displayName') ?? displayName(person);
      input.dataset.field = 'displayName';
      input.addEventListener('input', () => editDraft.set('displayName', input.value));
      nameCard.append(input);
    } else {
      nameCard.append(element('p', 'basic-value', displayName(person)), renderSource(person.displayName));
    }
    const firstRow = element('div', 'basic-row basic-row-three');
    firstRow.append(nameCard, renderField('gender', person.fields?.gender), renderField('age', person.fields?.age));
    fields.append(firstRow);
    for (const key of ARCHIVE_V2_DOSSIER_FIELD_KEYS.filter(item => !['gender', 'age'].includes(item))) {
      const row = element('div', 'basic-row basic-row-one');
      row.append(renderField(key, person.fields?.[key]));
      fields.append(row);
    }
    section.append(fields);
    if (message) section.append(element('p', `basic-message ${message.kind}`, message.text));
    return section;
  }

  function renderFollowedProfiles() {
    const result = model?.followedProfileResult ?? { status: 'idle' };
    const status = result.status ?? 'idle';
    const hasBaseProfile = orderedPeople().filter(followed).some(person => ARCHIVE_V2_DOSSIER_FIELD_KEYS.some(key => {
      const value = person.fields?.[key]?.value;
      return typeof value === 'string' && value.trim() !== '';
    }));
    const stable = ['idle', 'ready', 'saved'].includes(status);
    if (hasBaseProfile && stable) return null;
    const banner = element('section', 'generation-banner');
    const busy = operationBusy || model?.busy;
    if (stable) {
      banner.append(element('h3', '', '生成基础人设'));
      banner.append(element('p', '', '先生成全部关注人物的内存草稿，你确认后才会写入。'));
      const actionsBox = element('div', 'generation-actions');
      actionsBox.append(button('生成基础人设', 'primary-action', () => model?.generateFollowedProfiles?.(), busy || result.followedCount === 0));
      banner.append(actionsBox);
      return banner;
    }
    if (status === 'empty') {
      banner.append(element('h3', '', '当前没有关注人物'), element('p', '', '可在因缘簿中将静默人物设为关注。'));
      return banner;
    }
    if (status === 'running' || status === 'saving') {
      banner.append(element('h3', '', status === 'running' ? '正在生成基础人设' : '正在保存基础人设'), element('p', '', '切换聊天或禁用插件时，迟到结果不会覆盖当前档案。'));
      return banner;
    }
    if (status === 'draft') {
      banner.append(element('h3', '', '基础人设草稿'), element('p', '', '以下只是内存草稿，保存时仍会保护用户手工字段。'));
      for (const person of Array.isArray(result.draft?.people) ? result.draft.people : []) {
        const card = element('div', 'pending-card');
        card.append(element('b', '', person.displayName || '未命名人物'));
        for (const key of ARCHIVE_V2_DOSSIER_FIELD_KEYS) {
          const value = person.fields?.[key]?.value;
          if (typeof value === 'string' && value.trim()) {
            card.append(element('p', 'pending-value', `${ARCHIVE_V2_DOSSIER_FIELD_LABELS[key]}：${value}`));
          }
        }
        banner.append(card);
      }
      const actionsBox = element('div', 'generation-actions');
      actionsBox.append(button('保存基础人设', 'primary-action', () => model?.commitFollowedProfiles?.(), busy));
      banner.append(actionsBox);
      return banner;
    }
    banner.append(element('h3', '', '基础人设未保存'), element('p', '', {
      conflict: '档案在草稿生成后已变化，本次没有覆盖。',
      stale: '当前聊天已经变化。',
      disabled: '千千结当前未启用。',
      memory_not_ready: '记忆扫描尚未完成。',
      people_missing: '人物整理结果不可用。',
    }[status] ?? '本次操作没有完成，正式档案没有改变。'));
    if (!['stale', 'disabled', 'memory_not_ready', 'people_missing'].includes(status)) {
      const actionsBox = element('div', 'generation-actions');
      actionsBox.append(button('重新生成基础人设', 'primary-action', () => model?.generateFollowedProfiles?.(), busy));
      banner.append(actionsBox);
    }
    return banner;
  }

  function renderDossier(person) {
    if (!person) return element('p', 'layer-empty', '还没有关注人物。请打开“因缘簿”选择一位人物。');
    const dossier = element('section', 'dossier-card');
    const summary = element('header', 'profile-summary');
    summary.append(element('span', 'subject-tag tag-c', 'C'));
    const copy = element('div');
    copy.append(element('h2', '', displayName(person)), element('p', '', '当前关注人物的稳定关系档案'));
    summary.append(copy);
    dossier.append(summary);
    const followedProfiles = renderFollowedProfiles();
    if (followedProfiles) dossier.append(followedProfiles);
    dossier.append(renderBasicInfo(person));
    const dynamic = element('section', 'dynamic-info');
    const head = element('div', 'dynamic-info-head');
    const dynamicCopy = element('div');
    dynamicCopy.append(element('h3', '', '动态信息'), element('p', '', '事件、关系与下一步仍使用 V2 档案，本批不扩展未实现业务。'));
    head.append(dynamicCopy);
    dynamic.append(head, element('p', 'layer-empty', '动态状态尚未接入。'));
    dossier.append(dynamic);
    return dossier;
  }

  function renderMore(active, railIds) {
    const section = element('section', 'people-content more-view');
    const heading = element('div', 'content-heading');
    const hidden = active.filter(person => !railIds.includes(person.identityId));
    heading.append(element('h2', '', `更多人物（${hidden.length}）`), element('p', '', '选择后回到该人物档案。'));
    section.append(heading);
    const list = element('div', 'more-list');
    for (const person of hidden) list.append(button(displayName(person), 'more-person', () => {
      selectedIdentityId = person.identityId;
      contentMode = 'dossier';
      editing = false;
      requestRender();
    }));
    if (!hidden.length) list.append(element('p', 'layer-empty', '所有关注人物都已在快捷栏中。'));
    section.append(list);
    return section;
  }

  function renderFateBook(people) {
    const section = element('section', 'people-content fate-book-view');
    const heading = element('div', 'content-heading');
    const activeCount = people.filter(followed).length;
    heading.append(
      element('h2', '', '因缘簿'),
      element('p', '', `当前关注 ${activeCount} 人 · 静默 ${people.length - activeCount} 人。“关注”只表示进入千人主列表，不代表恋爱关系已经成立。`),
    );
    section.append(heading);
    const list = element('div', 'people-list');
    for (const person of people) {
      const card = element('article', 'module person-card');
      const head = element('div', 'fate-person-head');
      const title = element('div');
      title.append(element('b', 'fate-person-name', displayName(person)), element('small', 'fate-person-state', followed(person) ? '当前关注' : '静默人物'));
      head.append(title, element('span', `subject-tag ${followed(person) ? 'tag-c' : 'tag-u'}`, followed(person) ? 'C' : '静'));
      card.append(head);
      const rename = element('div', 'fate-person-rename');
      const input = element('input');
      input.value = fateNameDrafts.get(person.identityId) ?? displayName(person);
      input.setAttribute('aria-label', `修改${displayName(person)}的姓名`);
      input.addEventListener('input', () => fateNameDrafts.set(person.identityId, input.value));
      rename.append(input, button('保存名称', 'person-action', () => {
        const next = (fateNameDrafts.get(person.identityId) ?? input.value).trim();
        if (!next) { message = { kind: 'error', text: '人物姓名不能为空。' }; requestRender(); return; }
        runAction(() => actions.renamePerson({ identityId: person.identityId, displayName: next }), '人物姓名已保存。', () => fateNameDrafts.delete(person.identityId));
      }, operationBusy || model?.busy));
      card.append(rename);
      const controls = element('div', 'person-actions');
      controls.append(button(followed(person) ? '转为静默' : '设为关注', 'person-action', () => {
        runAction(
          () => actions.setFollowed({ identityId: person.identityId, followed: !followed(person) }),
          followed(person) ? '已转为静默人物。' : '已设为关注人物。',
        );
      }, operationBusy || model?.busy));
      card.append(controls);
      list.append(card);
    }
    if (!people.length) list.append(element('p', 'pool-empty', '正式档案中还没有人物。'));
    section.append(list);
    if (message) section.append(element('p', `basic-message ${message.kind}`, message.text));
    return section;
  }

  function render(nextModel = {}) {
    model = nextModel;
    const people = orderedPeople();
    const active = syncSelection(people);
    const root = element('section', 'people-page archive-v2-dossier');
    root.__stageKey = 'archive-ready';
    const railShell = element('div', 'profile-rail-shell');
    const switcher = element('div', 'profile-switcher');
    switcher.setAttribute('role', 'tablist');
    let rail = active.slice(0, RAIL_LIMIT);
    const selected = active.find(person => person.identityId === selectedIdentityId);
    if (selected && !rail.includes(selected)) rail = [...rail.slice(0, Math.max(0, RAIL_LIMIT - 1)), selected];
    const railIds = rail.map(person => person.identityId);
    for (const person of rail) {
      const activeTab = contentMode === 'dossier' && person.identityId === selectedIdentityId;
      const tab = button('', `profile-tab${activeTab ? ' active' : ''}`, () => {
        selectedIdentityId = person.identityId;
        contentMode = 'dossier';
        editing = false;
        message = null;
        requestRender();
      });
      tab.dataset.profileId = person.identityId;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(activeTab));
      tab.append(element('span', 'subject-tag tag-c', 'C'), element('span', 'profile-tab-name', displayName(person)));
      switcher.append(tab);
    }
    const tools = element('div', 'profile-tools');
    for (const [mode, label] of [['more', '更多'], ['fateBook', '因缘簿']]) {
      tools.append(button(label, `profile-tool${contentMode === mode ? ' active' : ''}`, () => {
        contentMode = contentMode === mode && selectedIdentityId ? 'dossier' : mode;
        editing = false;
        message = null;
        requestRender();
      }));
    }
    railShell.append(switcher, tools);
    root.append(railShell);
    if (Array.isArray(model?.readResult?.warnings) && model.readResult.warnings.length) {
      root.append(element('p', 'basic-message error', '当前身份与建档时有所变化，请确认人物后再继续。'));
    }
    if (contentMode === 'more') root.append(renderMore(active, railIds));
    else if (contentMode === 'fateBook') root.append(renderFateBook(people));
    else root.append(renderDossier(selected));
    return root;
  }

  function invalidate() {
    epoch += 1;
    operationBusy = false;
    editing = false;
    message = null;
    editDraft.clear();
    fateNameDrafts.clear();
  }

  return Object.freeze({ render, invalidate });
}
