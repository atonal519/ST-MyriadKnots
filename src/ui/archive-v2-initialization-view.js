import { createArchiveV2DossierView } from './archive-v2-dossier-view.js';
import { validateArchiveV2 } from '../archive-v2.js';

const STEPS = Object.freeze([
  ['sources', '来源'],
  ['candidates', '人物'],
  ['profiles', '档案'],
  ['completed', '完成'],
]);

const FIELD_LABELS = Object.freeze({
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
});

const FOLLOWED_PROFILE_FIELD_LABELS = Object.freeze({
  ...FIELD_LABELS,
  nsfwPreferences: '亲密偏好',
});

const KIND_LABELS = Object.freeze({
  card: '角色卡',
  greeting: '开场白',
  worldbook: '世界书',
  chat: '聊天正文',
});

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} 必须是函数`);
}

function safeErrorText(error, fallback = '操作没有完成，当前内容已保留，请重试。') {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code.includes('NO_SOURCES')) return '请至少选择一个可用来源。';
  if (code.includes('CHAT_RANGE')) return '聊天楼层范围无效，请检查开始和结束楼层。';
  if (code.includes('CONTEXT')) return '当前聊天已经变化，请重新打开此页面。';
  if (code.includes('BUSY')) return '当前操作尚未完成，请稍候。';
  return fallback;
}

function terminalText(status) {
  if (status === 'conflict') return '档案在保存时发生冲突，当前编辑已保留，请重试。';
  if (status === 'stale') return '当前聊天已经变化，请重新打开此页面。';
  if (status === 'disabled') return '千千结当前未启用，当前编辑已保留。';
  return '';
}

function warningText(code) {
  if (code === 'greeting_transient_swipe_mismatch') return '开场白正在切换，本次没有采用不稳定内容。';
  if (code === 'chat_swipe_unstable') return '部分聊天楼层正在切换，本次已安全跳过。';
  if (typeof code === 'string' && code.includes('worldbook')) return '部分世界书未读取，不影响其他可用来源。';
  return '部分来源未读取，不影响其他可用来源。';
}

function splitAliases(value) {
  return String(value ?? '').split(/[\n,，]/).map(item => item.trim()).filter(Boolean);
}

export function createArchiveV2InitializationView({
  composition,
  memory,
  followedProfiles,
  dossier,
  dossierViewFactory = createArchiveV2DossierView,
  documentRef = globalThis.document,
  onArchiveReady = () => {},
  onCompleted = () => {},
} = {}) {
  const flow = composition?.flow;
  const memoryMode = ['inspect', 'start', 'getState'].every(name => typeof memory?.[name] === 'function');
  const memoryPeopleMode = memoryMode
    && typeof memory?.consolidatePeople === 'function'
    && typeof memory?.confirmPeople === 'function';
  const followedProfileMode = ['inspect', 'generate', 'commit', 'getState']
    .every(name => typeof followedProfiles?.[name] === 'function');
  for (const [value, label] of [
    [composition?.readArchive, 'composition.readArchive'],
    [composition?.currentIdentity, 'composition.currentIdentity'],
    [flow?.getState, 'flow.getState'],
    [flow?.loadSources, 'flow.loadSources'],
    [flow?.setSourceSelected, 'flow.setSourceSelected'],
    [flow?.recognizeCandidates, 'flow.recognizeCandidates'],
    [flow?.setCandidateSelected, 'flow.setCandidateSelected'],
    [flow?.renameCandidate, 'flow.renameCandidate'],
    [flow?.setCandidateAliases, 'flow.setCandidateAliases'],
    [flow?.mergeCandidates, 'flow.mergeCandidates'],
    [flow?.removeCandidate, 'flow.removeCandidate'],
    [flow?.generateProfiles, 'flow.generateProfiles'],
    [flow?.setProfileField, 'flow.setProfileField'],
    [flow?.backToSources, 'flow.backToSources'],
    [flow?.backToCandidates, 'flow.backToCandidates'],
    [flow?.commitInitialization, 'flow.commitInitialization'],
  ]) requireFunction(value, label);
  if (!documentRef || typeof documentRef.createElement !== 'function') {
    throw new TypeError('documentRef 必须能创建元素');
  }
  requireFunction(onArchiveReady, 'onArchiveReady');
  requireFunction(onCompleted, 'onCompleted');
  if (dossier !== undefined && typeof dossierViewFactory !== 'function') {
    throw new TypeError('dossierViewFactory 必须是函数');
  }
  const dossierView = dossier === undefined ? null : dossierViewFactory({ actions: dossier, documentRef });

  let root = null;
  let progress = null;
  let status = null;
  let content = null;
  let active = false;
  let destroyed = false;
  let epoch = 0;
  let localBusy = false;
  let busy = false;
  let readMode = 'idle';
  let readResult = null;
  let memoryResult = null;
  let memoryStartPromise = null;
  let memoryPeoplePromise = null;
  let memoryCommitPromise = null;
  let memoryPollTimer = null;
  let followedProfileResult = null;
  let followedProfilePromise = null;
  let followedProfileCommitPromise = null;
  let errorText = '';
  let activationPromise = null;
  let pendingAction = null;
  let renderedStage = '';
  let lastFlowStage = 'idle';
  let completedNotified = false;
  let archiveReadyEpoch = -1;
  let inputCounter = 0;
  let renderCleanups = [];
  const candidateEdits = new Map();
  const profileDrafts = new Map();
  const memoryPeopleSelection = new Map();
  let memoryPeopleSelectionKey = '';
  const chatRange = { start: '', end: '' };

  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  };
  const append = (parent, ...children) => {
    for (const child of children) if (child !== null && child !== undefined) parent.append(child);
    return parent;
  };
  const listen = (node, type, handler) => {
    node.addEventListener(type, handler);
    renderCleanups.push(() => node.removeEventListener(type, handler));
  };
  const clearRenderListeners = () => {
    for (const cleanup of renderCleanups.splice(0)) cleanup();
  };
  const isCurrent = token => active && !destroyed && token === epoch && root !== null;

  function ownsNode(node) {
    for (let current = node; current; current = current.parentNode) if (current === root) return true;
    return false;
  }

  function withFocusKey(node, key) {
    if (key) {
      node.dataset.focusKey = key;
      node.setAttribute('data-focus-key', key);
    }
    return node;
  }

  function focusedKey() {
    const focused = documentRef.activeElement;
    return ownsNode(focused) && typeof focused?.dataset?.focusKey === 'string'
      ? focused.dataset.focusKey
      : '';
  }

  function findFocusTarget(key) {
    if (!key || !content) return null;
    return [...content.querySelectorAll('[data-focus-key]')]
      .find(node => node.dataset.focusKey === key) ?? null;
  }

  function profileDraft(identityId, field, fallback) {
    const fields = profileDrafts.get(identityId);
    return fields?.has(field) ? fields.get(field) : fallback;
  }

  function setProfileDraft(identityId, field, value) {
    let fields = profileDrafts.get(identityId);
    if (!fields) {
      fields = new Map();
      profileDrafts.set(identityId, fields);
    }
    fields.set(field, value);
  }

  function actionButton(label, className, handler, disabled = false, focusKey = '') {
    const button = withFocusKey(element('button', className, label), focusKey);
    button.type = 'button';
    button.disabled = disabled;
    listen(button, 'click', () => {
      if (!active || button.disabled) return;
      const state = flowStage();
      if (localBusy || state.busy === true || pendingAction) {
        render({ restoreFocusKey: focusedKey() });
        return;
      }
      handler();
    });
    return button;
  }

  function statusForState(state) {
    if (errorText) return errorText;
    if (memoryMode && readMode === 'memory') {
      if (memoryResult?.status === 'checking') return '正在检查已有扫描进度。';
      if (memoryResult?.status === 'scanning') return '记忆扫描正在后台进行。';
      if (memoryResult?.status === 'interrupted') return '扫描可以从已保存的批次继续。';
      if (memoryResult?.status === 'ready') return '记忆扫描已经完成。';
    }
    if (followedProfileMode && readMode === 'ready') {
      if (followedProfileResult?.status === 'running') return '正在生成关注人物的基础人设。';
      if (followedProfileResult?.status === 'saving') return '正在保存基础人设。';
      if (followedProfileResult?.status === 'draft') return '基础人设草稿已生成，确认后才会保存。';
      if (followedProfileResult?.status === 'saved') return '基础人设已经保存。';
      if (followedProfileResult?.status === 'error') return '基础人设操作没有完成，正式档案没有改变。';
    }
    if (busy) return '正在处理，请稍候。';
    if (readMode === 'loading') return '正在读取当前档案。';
    if (state?.stage === 'sources') return '请确认本次用于建档的来源。';
    if (state?.stage === 'candidates') return '请决定要收入档案的人物。';
    if (state?.stage === 'profiles') return '请审核基础档案，确认后再保存。';
    if (state?.stage === 'completed') return '档案已经建立。';
    return '';
  }

  function renderProgress(stage) {
    if (memoryMode) {
      progress.replaceChildren();
      return;
    }
    const currentIndex = Math.max(0, STEPS.findIndex(([key]) => key === stage));
    const list = element('ol', 'qqj-v2-progress-list');
    STEPS.forEach(([key, label], index) => {
      const item = element('li', 'qqj-v2-progress-step');
      if (index < currentIndex) item.className += ' is-complete';
      if (index === currentIndex) {
        item.className += ' is-current';
        item.setAttribute('aria-current', 'step');
      }
      append(item, element('span', 'qqj-v2-knot', String(index + 1)), element('span', 'qqj-v2-step-label', label));
      list.append(item);
    });
    progress.replaceChildren(list);
  }

  function heading(title, intro, stageKey) {
    const box = element('header', 'qqj-v2-heading');
    const titleNode = element('h2', 'qqj-v2-title', title);
    titleNode.tabIndex = -1;
    append(box, titleNode, element('p', 'qqj-v2-intro', intro));
    box.__heading = titleNode;
    box.__stageKey = stageKey;
    return box;
  }

  function renderReadState() {
    if (readMode === 'loading' || readMode === 'idle') {
      return heading('正在打开千千结', '只读取当前聊天的建档状态，不会调用 AI 或写入内容。', 'loading');
    }
    if (readMode === 'disabled') {
      return heading('千千结当前未启用', '启用后重新打开此页面，即可继续整理当前聊天。', 'disabled');
    }
    if (readMode === 'stale') {
      return heading('当前聊天已经变化', '请重新打开初次建档页面，旧结果不会进入新聊天。', 'stale');
    }
    if (readMode === 'error') {
      return heading('暂时无法读取档案', '读取没有完成，请稍后重新打开此页面。', 'read-error');
    }
    if (readMode === 'ready') return renderArchiveReady();
    return renderUninitialized();
  }

  function normalizeFollowedProfileResult(value) {
    const allowed = new Set([
      'idle', 'ready', 'empty', 'running', 'draft', 'saving', 'saved', 'error', 'conflict',
      'stale', 'disabled', 'source_changed', 'memory_not_ready', 'people_missing', 'uninitialized',
    ]);
    const result = value && typeof value === 'object' ? value : {};
    return Object.freeze({
      status: allowed.has(result.status) ? result.status : 'error',
      followedCount: Number.isSafeInteger(result.followedCount) ? Math.max(0, result.followedCount) : 0,
      enrichedCount: Number.isSafeInteger(result.enrichedCount) ? Math.max(0, result.enrichedCount) : 0,
      savedFieldCount: Number.isSafeInteger(result.savedFieldCount) ? Math.max(0, result.savedFieldCount) : 0,
      protectedFieldCount: Number.isSafeInteger(result.protectedFieldCount) ? Math.max(0, result.protectedFieldCount) : 0,
      draft: result.draft && typeof result.draft === 'object' ? result.draft : null,
    });
  }

  function followedProfileStateForArchive(archive) {
    const order = Array.isArray(archive?.people?.order) ? archive.people.order : [];
    const followed = order
      .map(identityId => archive?.people?.byId?.[identityId])
      .filter(person => person?.followed === true);
    const enrichedCount = followed.filter(person => Object.values(person?.fields ?? {}).some(field => {
      const value = field?.value;
      return typeof value === 'string' && value.trim() !== '';
    })).length;
    return normalizeFollowedProfileResult({
      status: followed.length ? 'ready' : 'empty',
      followedCount: followed.length,
      enrichedCount,
    });
  }

  function readyResultFromMemoryCommit(result) {
    if (result?.status !== 'created'
      || !Number.isSafeInteger(result.revision)
      || result.revision < 1) return null;
    let archive;
    try { archive = validateArchiveV2(result.archive); }
    catch { return null; }
    return {
      status: 'ready',
      archive,
      revision: result.revision,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
    };
  }

  function followedProfileDraftFieldCount(draft) {
    return Array.isArray(draft?.people)
      ? draft.people.reduce((total, person) => total + Object.keys(person?.fields ?? {}).length, 0)
      : 0;
  }

  function renderFollowedProfileDraft(draft) {
    const people = Array.isArray(draft?.people) ? draft.people : [];
    const list = element('div', 'qqj-v2-followed-profile-list');
    for (const person of people) {
      const card = element('section', 'qqj-v2-followed-profile-person');
      card.append(element('h4', 'qqj-v2-followed-profile-name', person.displayName || '未命名人物'));
      const fields = element('dl', 'qqj-v2-followed-profile-fields');
      for (const key of Object.keys(FOLLOWED_PROFILE_FIELD_LABELS)) {
        const value = person?.fields?.[key]?.value;
        if (typeof value !== 'string' || !value.trim()) continue;
        append(fields,
          element('dt', 'qqj-v2-followed-profile-field-name', FOLLOWED_PROFILE_FIELD_LABELS[key]),
          element('dd', 'qqj-v2-followed-profile-field-value', value),
        );
      }
      card.append(fields);
      list.append(card);
    }
    return list;
  }

  function renderFollowedProfiles() {
    const result = followedProfileResult ?? normalizeFollowedProfileResult({ status: 'idle' });
    const section = element('section', 'qqj-v2-followed-profiles');
    section.append(element('h3', 'qqj-v2-subtitle', '关注人物基础人设'));
    if (['idle', 'ready'].includes(result.status)) {
      section.append(element('p', 'qqj-v2-reason', '一次为全部关注人物生成基础人设草稿，确认前不会写入档案。'));
      const actions = element('div', 'qqj-v2-actions');
      actions.append(actionButton(
        '生成基础人设', 'qqj-v2-button qqj-v2-primary', generateFollowedProfiles,
        localBusy || result.followedCount === 0, 'followed-profiles:generate',
      ));
      section.append(actions);
      return section;
    }
    if (result.status === 'empty') {
      section.append(element('p', 'qqj-v2-reason', '当前没有关注人物，无需生成基础人设。'));
      return section;
    }
    if (result.status === 'running') {
      section.append(element('p', 'qqj-v2-reason', '正在为全部关注人物生成基础人设。关闭面板不会取消本次请求。'));
      return section;
    }
    if (result.status === 'saving') {
      section.append(element('p', 'qqj-v2-reason', '正在使用档案 revision 安全保存，请稍候。'));
      return section;
    }
    if (result.status === 'saved') {
      section.append(element('p', 'qqj-v2-count', `已保存 ${result.savedFieldCount} 个字段`));
      if (result.protectedFieldCount) {
        section.append(element('p', 'qqj-v2-reason', `另有 ${result.protectedFieldCount} 个用户保护字段保持不变。`));
      }
      return section;
    }
    if (result.status === 'draft') {
      const fieldCount = followedProfileDraftFieldCount(result.draft);
      section.append(element('p', 'qqj-v2-reason', '以下内容只是内存草稿，点击保存后才会写入正式档案。'));
      section.append(renderFollowedProfileDraft(result.draft));
      const actions = element('div', 'qqj-v2-actions');
      actions.append(actionButton(
        '保存基础人设', 'qqj-v2-button qqj-v2-primary', commitFollowedProfiles,
        localBusy || fieldCount === 0, 'followed-profiles:commit',
      ));
      if (fieldCount === 0) actions.append(element('p', 'qqj-v2-reason', '本次没有可靠字段，请重新生成。'));
      section.append(actions);
      return section;
    }
    const copy = {
      conflict: '档案在草稿生成后已经变化，本次没有覆盖，请重新生成。',
      source_changed: '聊天记忆已经变化，本次没有生成草稿。',
      memory_not_ready: '聊天记忆扫描尚未完成，暂时不能补全人设。',
      people_missing: '人物整理结果不可用，暂时不能补全人设。',
      stale: '当前聊天已经变化，迟到结果不会进入新聊天。',
      disabled: '千千结当前未启用。',
      error: '基础人设操作没有完成，正式档案没有改变。',
    }[result.status] ?? '基础人设操作没有完成，正式档案没有改变。';
    section.append(element('p', 'qqj-v2-warning', copy));
    if (!['disabled', 'stale', 'memory_not_ready', 'people_missing'].includes(result.status)) {
      const actions = element('div', 'qqj-v2-actions');
      actions.append(actionButton('重新生成基础人设', 'qqj-v2-button qqj-v2-primary', generateFollowedProfiles, localBusy, 'followed-profiles:retry'));
      section.append(actions);
    }
    return section;
  }

  function renderArchiveReady() {
    if (dossierView) {
      return dossierView.render({
        readResult,
        followedProfileResult: followedProfileResult ?? normalizeFollowedProfileResult({ status: 'idle' }),
        busy: localBusy || followedProfileOperationPending() !== null,
        generateFollowedProfiles,
        commitFollowedProfiles,
        onArchiveChange(result) {
          readResult = {
            status: 'ready',
            archive: result.archive,
            revision: result.revision,
            warnings: Array.isArray(result.warnings) ? result.warnings : [],
          };
          try { onArchiveReady(result); } catch { /* consumer callback is isolated */ }
        },
        requestRender() { render(); },
      });
    }
    const section = element('section', 'qqj-v2-ready');
    const head = heading('档案已建立', '当前聊天已有千千结档案，本页只展示安全摘要。', 'archive-ready');
    section.append(head);
    const archive = readResult?.archive;
    const order = Array.isArray(archive?.people?.order) ? archive.people.order : [];
    const followed = order.filter(identityId => archive?.people?.byId?.[identityId]?.followed !== false);
    const silent = order.filter(identityId => archive?.people?.byId?.[identityId]?.followed === false);
    section.append(element('p', 'qqj-v2-count', `关注 ${followed.length} 人 · 静默 ${silent.length} 人`));
    if (followed.length) {
      const list = element('ul', 'qqj-v2-name-list');
      for (const identityId of followed) {
        const value = archive?.people?.byId?.[identityId]?.displayName?.value;
        list.append(element('li', '', typeof value === 'string' && value.trim() ? value : '未命名人物'));
      }
      section.append(list);
    }
    if (silent.length) {
      const details = element('details', 'qqj-v2-memory-silent');
      details.append(element('summary', '', `静默人物（${silent.length}）`));
      const list = element('ul', 'qqj-v2-name-list');
      for (const identityId of silent) {
        const value = archive?.people?.byId?.[identityId]?.displayName?.value;
        list.append(element('li', '', typeof value === 'string' && value.trim() ? value : '未命名人物'));
      }
      details.append(list);
      section.append(details);
    }
    if (Array.isArray(readResult?.warnings) && readResult.warnings.length) {
      section.append(element('p', 'qqj-v2-warning', '当前身份与建档时有所变化，请确认人物后再继续。'));
    }
    if (followedProfileMode) section.append(renderFollowedProfiles());
    return section;
  }

  function normalizeMemoryResult(value) {
    const allowed = new Set([
      'idle', 'checking', 'uninitialized', 'scanning', 'interrupted', 'ready',
      'conflict', 'source_changed', 'stale', 'disabled', 'error',
    ]);
    const result = value && typeof value === 'object' ? value : {};
    const statusValue = allowed.has(result.status) ? result.status : 'error';
    const integer = (candidate, fallback) => Number.isSafeInteger(candidate) ? candidate : fallback;
    const peopleStatuses = new Set([
      'idle', 'uninitialized', 'running', 'ready', 'error', 'committing', 'conflict', 'committed',
      'stale', 'disabled',
    ]);
    return Object.freeze({
      status: statusValue,
      targetFloor: result.targetFloor === null ? null : integer(result.targetFloor, null),
      eligibleFloorCount: result.eligibleFloorCount === null
        ? null
        : integer(result.eligibleFloorCount, null),
      completedBatches: Math.max(0, integer(result.completedBatches, 0)),
      totalBatches: Math.max(0, integer(result.totalBatches, 0)),
      currentBatchIndex: result.currentBatchIndex === null
        ? null
        : integer(result.currentBatchIndex, null),
      overRecommendedLimit: result.overRecommendedLimit === true,
      peopleStatus: peopleStatuses.has(result.peopleStatus) ? result.peopleStatus : 'uninitialized',
      peopleResult: result.peopleResult && typeof result.peopleResult === 'object' ? result.peopleResult : null,
      followedCount: Math.max(0, integer(result.followedCount, 0)),
      silentCount: Math.max(0, integer(result.silentCount, 0)),
    });
  }

  function memoryProgress(result) {
    const box = element('div', 'qqj-v2-memory-progress');
    const completed = Math.min(result.completedBatches, result.totalBatches);
    box.append(element('p', 'qqj-v2-memory-progress-copy', `已完成 ${completed} / ${result.totalBatches} 批`));
    const meter = element('progress', 'qqj-v2-memory-progress-meter');
    meter.max = Math.max(1, result.totalBatches);
    meter.value = completed;
    meter.setAttribute('aria-label', '记忆扫描进度');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', String(result.totalBatches));
    meter.setAttribute('aria-valuenow', String(completed));
    box.append(meter);
    if (Number.isSafeInteger(result.currentBatchIndex)) {
      box.append(element('p', 'qqj-v2-memory-current', `正在处理第 ${result.currentBatchIndex + 1} 批`));
    }
    return box;
  }

  function memoryAction(label) {
    const actions = element('div', 'qqj-v2-actions');
    actions.append(actionButton(
      label,
      'qqj-v2-button qqj-v2-primary',
      startMemory,
      busy || memoryOperationPending() !== null,
      'memory:start',
    ));
    return actions;
  }

  function renderMemoryState() {
    const result = memoryResult ?? normalizeMemoryResult({ status: 'error' });
    const section = element('section', 'qqj-v2-memory');
    if (result.status === 'uninitialized') {
      section.append(heading(
        '扫描当前聊天的记忆',
        '千千结会按顺序处理当前完整聊天，并在每批完成后保存进度。关闭面板不会中断后台扫描。',
        'memory-preview',
      ));
      const facts = element('div', 'qqj-v2-memory-facts');
      append(facts,
        element('p', 'qqj-v2-count', `截至第 ${result.targetFloor} 楼`),
        element('p', 'qqj-v2-count', `共 ${result.eligibleFloorCount ?? 0} 个 AI 正文楼层`),
        element('p', 'qqj-v2-count', `预计 ${result.totalBatches} 批`),
      );
      section.append(facts);
      if (result.overRecommendedLimit) {
        section.append(element(
          'p',
          'qqj-v2-warning',
          '当前有效 AI 楼层超过 500 层，扫描可能耗时较长，且人物整理精度可能受到影响。',
        ));
      }
      section.append(memoryAction('开始扫描记忆'));
      return section;
    }
    if (['checking', 'scanning', 'interrupted', 'idle'].includes(result.status)) {
      section.append(heading(
        result.status === 'interrupted' ? '继续扫描聊天记忆' : '正在扫描聊天记忆',
        '进度按批保存。你可以关闭面板，后台扫描会继续运行。',
        'memory-scanning',
      ));
      section.append(memoryProgress(result));
      if (!memoryStartPromise && ['idle', 'scanning', 'interrupted'].includes(result.status)) {
        section.append(memoryAction('继续扫描'));
      }
      return section;
    }
    if (result.status === 'ready') {
      if (!memoryPeopleMode) {
        section.append(heading(
          '记忆扫描完成，等待人物整理',
          '当前批次记忆已经安全保存。本阶段不会展示或推断人物名单。',
          'memory-ready',
        ));
        section.append(memoryProgress(result));
        return section;
      }
      return renderMemoryPeople(result);
    }
    const messages = {
      conflict: ['扫描进度保存发生冲突', '旧进度没有被覆盖，请重新打开后继续。'],
      source_changed: ['聊天正文已经变化', '旧扫描进度没有被覆盖，请确认当前聊天后再继续。'],
      stale: ['当前聊天已经变化', '迟到的扫描结果不会进入新聊天，请重新打开此页面。'],
      disabled: ['千千结当前未启用', '启用后重新打开此页面，即可继续扫描。'],
      error: ['暂时无法扫描记忆', '操作没有完成，已保存的批次不会丢失。请手动重新扫描，不会自动重试。'],
    };
    const [title, intro] = messages[result.status] ?? messages.error;
    section.append(heading(title, intro, `memory-${result.status}`));
    if (result.status === 'error') section.append(memoryAction('重新扫描'));
    return section;
  }

  function ensureMemoryPeopleSelection(result) {
    const people = Array.isArray(result.peopleResult?.people) ? result.peopleResult.people : [];
    const key = `${result.peopleResult?.scanId ?? ''}\u0000${result.peopleResult?.sourceFingerprint ?? ''}`;
    if (memoryPeopleSelectionKey !== key) {
      memoryPeopleSelection.clear();
      for (const person of people) {
        memoryPeopleSelection.set(person.localId, person.recommendation === 'romance_candidate');
      }
      memoryPeopleSelectionKey = key;
    }
    return people;
  }

  function memoryPeopleCard(person, result) {
    const card = element('article', 'qqj-v2-memory-person');
    const id = `qqj-v2-memory-person-${++inputCounter}`;
    const label = element('label', 'qqj-v2-memory-person-choice');
    label.htmlFor = id;
    const checkbox = withFocusKey(element('input', 'qqj-v2-checkbox'), `memory-person:${person.localId}`);
    checkbox.id = id;
    checkbox.type = 'checkbox';
    checkbox.checked = memoryPeopleSelection.get(person.localId) === true;
    checkbox.disabled = busy || ['committing', 'committed'].includes(result.peopleStatus);
    listen(checkbox, 'change', () => {
      memoryPeopleSelection.set(person.localId, checkbox.checked);
      render({ restoreFocusKey: `memory-person:${person.localId}` });
    });
    append(label, checkbox, element('strong', '', person.displayName));
    card.append(label);
    return card;
  }

  function renderMemoryPeople(result) {
    const section = element('section', 'qqj-v2-memory qqj-v2-memory-people');
    if (['idle', 'uninitialized'].includes(result.peopleStatus)) {
      section.append(heading(
        '记忆扫描完成，可以整理人物',
        '点击后只需一次 AI 调用：它会读取已保存的批次，归并全部人物并给出攻略对象建议。',
        'memory-people-uninitialized',
      ));
      section.append(memoryProgress(result));
      const actions = element('div', 'qqj-v2-actions');
      actions.append(actionButton(
        '整理人物', 'qqj-v2-button qqj-v2-primary', startMemoryPeople,
        busy || memoryPeoplePromise !== null, 'memory:people:start',
      ));
      section.append(actions);
      return section;
    }
    if (result.peopleStatus === 'running') {
      section.append(heading('正在整理千人', '关闭面板不会中断；切换聊天或禁用插件会使旧结果失效。', 'memory-people-running'));
      section.append(memoryProgress(result));
      return section;
    }
    if (result.peopleStatus === 'error') {
      section.append(heading('人物整理没有完成', '已保存的批次没有改变。你可以手动重新整理，不会自动重试。', 'memory-people-error'));
      const actions = element('div', 'qqj-v2-actions');
      actions.append(actionButton('重新整理', 'qqj-v2-button qqj-v2-primary', startMemoryPeople, busy, 'memory:people:retry'));
      section.append(actions);
      return section;
    }
    if (result.peopleStatus === 'committed') {
      section.append(heading('人物已经写入档案', '关注人物会进入千人主列表；静默人物保留在同一档案中，不消耗下一批人设补全。', 'memory-people-committed'));
      section.append(element('p', 'qqj-v2-count', `关注 ${result.followedCount} 人 · 静默 ${result.silentCount} 人`));
      const silent = element('details', 'qqj-v2-memory-silent');
      silent.append(element('summary', '', `静默人物（${result.silentCount}）`));
      const people = ensureMemoryPeopleSelection(result).filter(person => !memoryPeopleSelection.get(person.localId));
      const list = element('ul', 'qqj-v2-name-list');
      for (const person of people) list.append(element('li', '', person.displayName));
      silent.append(list);
      section.append(silent);
      return section;
    }
    const people = ensureMemoryPeopleSelection(result);
    section.append(heading(
      result.peopleStatus === 'conflict' ? '正式档案已经存在' : '选择要关注的人物',
      result.peopleStatus === 'conflict'
        ? '候选草稿仍然保留，本次没有覆盖已有 archive-v2。'
        : '请选择要关注的人物，其余人物将暂时静默。',
      `memory-people-${result.peopleStatus}`,
    ));
    const list = element('div', 'qqj-v2-memory-people-list');
    for (const person of people) list.append(memoryPeopleCard(person, result));
    section.append(list);
    const selected = [...memoryPeopleSelection.values()].filter(Boolean).length;
    section.append(element('p', 'qqj-v2-selection-count', `已选择关注 ${selected} 人；其余 ${people.length - selected} 人将静默保存`));
    if (result.peopleStatus !== 'conflict') {
      const actions = element('div', 'qqj-v2-actions');
      actions.append(actionButton(
        result.peopleStatus === 'committing' ? '正在确认' : '确认关注人物',
        'qqj-v2-button qqj-v2-primary',
        confirmMemoryPeople,
        busy || result.peopleStatus === 'committing',
        'memory:people:confirm',
      ));
      section.append(actions);
    }
    return section;
  }

  const memoryOperationPending = () => memoryStartPromise || memoryPeoplePromise || memoryCommitPromise;
  const followedProfileOperationPending = () => followedProfilePromise || followedProfileCommitPromise;

  function stopMemoryPolling() {
    if (memoryPollTimer === null) return;
    (documentRef.defaultView?.clearInterval ?? globalThis.clearInterval)(memoryPollTimer);
    memoryPollTimer = null;
  }

  function refreshMemoryState() {
    if (!active || destroyed || !root || !memoryOperationPending()) return;
    try {
      memoryResult = normalizeMemoryResult(memory.getState());
      readMode = 'memory';
      render();
    } catch { /* polling is read-only and isolated */ }
  }

  function startMemoryPolling() {
    if (memoryPollTimer !== null || !active || !memoryOperationPending()) return;
    const setIntervalImpl = documentRef.defaultView?.setInterval ?? globalThis.setInterval;
    memoryPollTimer = setIntervalImpl(refreshMemoryState, 350);
    memoryPollTimer?.unref?.();
  }

  function startMemory() {
    if (!memoryMode || !active || destroyed || memoryOperationPending()) return;
    localBusy = true;
    errorText = '';
    let started;
    try { started = Promise.resolve(memory.start()); }
    catch { started = Promise.reject(new Error('memory start failed')); }
    memoryStartPromise = started;
    try { memoryResult = normalizeMemoryResult(memory.getState()); }
    catch { memoryResult = normalizeMemoryResult({ status: 'checking' }); }
    readMode = 'memory';
    startMemoryPolling();
    render({ restoreFocusKey: 'memory:start' });
    started.then(
      result => ({ ok: true, result }),
      () => ({ ok: false }),
    ).then(outcome => {
      if (memoryStartPromise !== started) return;
      memoryStartPromise = null;
      stopMemoryPolling();
      if (!active || destroyed || !root) return;
      localBusy = false;
      memoryResult = normalizeMemoryResult(outcome.ok ? outcome.result : { status: 'error' });
      readMode = 'memory';
      render({ restoreFocusKey: 'memory:start' });
    });
  }

  function settleMemoryOperation(slot, started, resultFocusKey, { notify = false } = {}) {
    started.then(
      result => ({ ok: true, result }),
      () => ({ ok: false, result: { status: 'error' } }),
    ).then(outcome => {
      if (slot() !== started) return;
      if (memoryPeoplePromise === started) memoryPeoplePromise = null;
      if (memoryCommitPromise === started) memoryCommitPromise = null;
      stopMemoryPolling();
      if (!active || destroyed || !root) return;
      localBusy = false;
      try { memoryResult = normalizeMemoryResult(memory.getState()); }
      catch { memoryResult = normalizeMemoryResult(outcome.ok ? outcome.result : { status: 'ready', peopleStatus: 'error' }); }
      const readyResult = notify && outcome.ok ? readyResultFromMemoryCommit(outcome.result) : null;
      if (readyResult) {
        readResult = readyResult;
        readMode = 'ready';
        if (followedProfileMode) followedProfileResult = followedProfileStateForArchive(readyResult.archive);
      } else {
        readMode = 'memory';
      }
      render({ restoreFocusKey: readyResult ? '' : resultFocusKey });
      if (readyResult) {
        try { onCompleted(outcome.result); } catch { /* consumer callback is isolated */ }
        try { onArchiveReady(outcome.result); } catch { /* consumer callback is isolated */ }
      }
    });
  }

  function startMemoryPeople() {
    if (!memoryPeopleMode || !active || destroyed || memoryOperationPending()) return;
    localBusy = true;
    errorText = '';
    let started;
    try { started = Promise.resolve(memory.consolidatePeople()); }
    catch { started = Promise.reject(new Error('memory people failed')); }
    memoryPeoplePromise = started;
    try { memoryResult = normalizeMemoryResult(memory.getState()); }
    catch { memoryResult = normalizeMemoryResult({ status: 'ready', peopleStatus: 'running' }); }
    readMode = 'memory';
    startMemoryPolling();
    render({ restoreFocusKey: 'memory:people:start' });
    settleMemoryOperation(() => memoryPeoplePromise, started, 'memory:people:start');
  }

  function confirmMemoryPeople() {
    if (!memoryPeopleMode || !active || destroyed || memoryOperationPending()) return;
    localBusy = true;
    errorText = '';
    const selectedLocalIds = [...memoryPeopleSelection].filter(([, selected]) => selected).map(([localId]) => localId);
    let started;
    try { started = Promise.resolve(memory.confirmPeople({ selectedLocalIds })); }
    catch { started = Promise.reject(new Error('memory commit failed')); }
    memoryCommitPromise = started;
    try { memoryResult = normalizeMemoryResult(memory.getState()); }
    catch { memoryResult = normalizeMemoryResult({ status: 'ready', peopleStatus: 'committing' }); }
    readMode = 'memory';
    startMemoryPolling();
    render({ restoreFocusKey: 'memory:people:confirm' });
    settleMemoryOperation(() => memoryCommitPromise, started, 'memory:people:confirm', { notify: true });
  }

  function settleFollowedProfileOperation(slot, started, focusKey) {
    started.then(
      result => ({ ok: true, result }),
      () => ({ ok: false, result: { status: 'error' } }),
    ).then(outcome => {
      if (slot() !== started) return;
      if (followedProfilePromise === started) followedProfilePromise = null;
      if (followedProfileCommitPromise === started) followedProfileCommitPromise = null;
      if (!active || destroyed || !root) return;
      localBusy = memoryOperationPending() !== null || pendingAction !== null;
      try { followedProfileResult = normalizeFollowedProfileResult(followedProfiles.getState()); }
      catch { followedProfileResult = normalizeFollowedProfileResult(outcome.ok ? outcome.result : { status: 'error' }); }
      if (outcome.ok && outcome.result?.status === 'saved' && outcome.result.archive) {
        readResult = {
          status: 'ready', archive: outcome.result.archive, revision: outcome.result.revision,
          warnings: Array.isArray(outcome.result.warnings) ? outcome.result.warnings : [],
        };
        try { onArchiveReady(outcome.result); } catch { /* consumer callback is isolated */ }
      }
      render({ restoreFocusKey: focusKey });
    });
  }

  function generateFollowedProfiles() {
    if (!followedProfileMode || !active || destroyed || followedProfileOperationPending() || memoryOperationPending()) return;
    localBusy = true;
    errorText = '';
    let started;
    try { started = Promise.resolve(followedProfiles.generate()); }
    catch { started = Promise.reject(new Error('followed profile generation failed')); }
    followedProfilePromise = started;
    try { followedProfileResult = normalizeFollowedProfileResult(followedProfiles.getState()); }
    catch { followedProfileResult = normalizeFollowedProfileResult({ status: 'running' }); }
    render({ restoreFocusKey: 'followed-profiles:generate' });
    settleFollowedProfileOperation(() => followedProfilePromise, started, 'followed-profiles:generate');
  }

  function commitFollowedProfiles() {
    if (!followedProfileMode || !active || destroyed || followedProfileOperationPending() || memoryOperationPending()) return;
    localBusy = true;
    errorText = '';
    let started;
    try { started = Promise.resolve(followedProfiles.commit()); }
    catch { started = Promise.reject(new Error('followed profile commit failed')); }
    followedProfileCommitPromise = started;
    try { followedProfileResult = normalizeFollowedProfileResult(followedProfiles.getState()); }
    catch { followedProfileResult = normalizeFollowedProfileResult({ status: 'saving' }); }
    render({ restoreFocusKey: 'followed-profiles:commit' });
    settleFollowedProfileOperation(() => followedProfileCommitPromise, started, 'followed-profiles:commit');
  }

  function parseChatRange() {
    const startText = chatRange.start.trim();
    const endText = chatRange.end.trim();
    if (!startText && !endText) return { ok: true, value: undefined };
    if (!startText || !endText || !/^\d+$/.test(startText) || !/^\d+$/.test(endText)) return { ok: false };
    const start = Number(startText);
    const end = Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return { ok: false };
    return { ok: true, value: { start, end } };
  }

  function renderUninitialized() {
    const section = element('section', 'qqj-v2-uninitialized');
    section.append(heading(
      '为当前聊天建立千千结',
      '先由你选择来源，AI 只识别人选并起草基础字段；最终内容仍由你确认。整个过程可以返回上一步。',
      'uninitialized',
    ));
    const details = element('details', 'qqj-v2-chat-range');
    details.append(element('summary', '', '加入聊天正文（可选）'));
    const fields = element('div', 'qqj-v2-range-fields');
    for (const key of ['start', 'end']) {
      const id = `qqj-v2-range-${key}-${++inputCounter}`;
      const label = element('label', 'qqj-v2-field-label', key === 'start' ? '开始楼层' : '结束楼层');
      label.htmlFor = id;
      const input = withFocusKey(element('input', 'qqj-v2-number-input'), `range:${key}`);
      input.id = id;
      input.type = 'number';
      input.min = '0';
      input.inputMode = 'numeric';
      input.value = chatRange[key];
      listen(input, 'input', () => { chatRange[key] = input.value; });
      append(fields, label, input);
    }
    details.append(fields);
    const start = actionButton('选择建档来源', 'qqj-v2-button qqj-v2-primary', () => {
      const parsed = parseChatRange();
      if (!parsed.ok) {
        errorText = '请完整填写有效的开始和结束楼层，且开始不能晚于结束。';
        render();
        return;
      }
      runAsync(() => parsed.value === undefined ? flow.loadSources() : flow.loadSources({ chatRange: parsed.value }));
    }, busy, 'uninitialized:load');
    const actions = element('div', 'qqj-v2-actions');
    actions.append(start);
    append(section, details, actions);
    return section;
  }

  function renderSources(state) {
    const section = element('section', 'qqj-v2-sources');
    section.append(heading('选择建档来源', '只有勾选的可用来源才会交给 AI；正文、内部位置与指纹不会显示在这里。', 'sources'));
    const list = element('div', 'qqj-v2-source-list');
    const sources = Array.isArray(state.sources) ? state.sources : [];
    for (const source of sources) {
      const id = `qqj-v2-source-${++inputCounter}`;
      const row = element('label', `qqj-v2-source-row${source.availability === 'disabled' ? ' is-disabled' : ''}`);
      row.htmlFor = id;
      const checkbox = withFocusKey(element('input', 'qqj-v2-checkbox'), `source:${source.id}:selected`);
      checkbox.id = id;
      checkbox.type = 'checkbox';
      checkbox.checked = source.selected === true;
      checkbox.disabled = busy || source.availability === 'disabled';
      listen(checkbox, 'change', () => syncAction(() => flow.setSourceSelected(source.id, checkbox.checked)));
      const copy = element('span', 'qqj-v2-source-copy');
      append(copy,
        element('strong', '', typeof source.label === 'string' ? source.label : '未命名来源'),
        element('small', '', source.availability === 'disabled'
          ? `${KIND_LABELS[source.kind] || '其他来源'} · 当前不可用`
          : KIND_LABELS[source.kind] || '其他来源'),
      );
      append(row, checkbox, copy);
      list.append(row);
    }
    section.append(list);
    const selected = sources.filter(source => source.selected === true && source.availability !== 'disabled').length;
    section.append(element('p', 'qqj-v2-selection-count', `已选择 ${selected} 项可用来源`));
    if (Array.isArray(state.warnings)) for (const warning of state.warnings) {
      section.append(element('p', 'qqj-v2-warning', warningText(warning?.code)));
    }
    const actions = element('div', 'qqj-v2-actions');
    actions.append(actionButton('识别人选', 'qqj-v2-button qqj-v2-primary', () => runAsync(
      () => flow.recognizeCandidates(),
    ), busy || selected === 0, 'sources:recognize'));
    section.append(actions);
    return section;
  }

  function editFor(candidate) {
    let edit = candidateEdits.get(candidate.candidateId);
    if (!edit) {
      edit = { name: candidate.displayName, aliases: Array.isArray(candidate.aliases) ? candidate.aliases.join('，') : '', targetId: '' };
      candidateEdits.set(candidate.candidateId, edit);
    }
    return edit;
  }

  function renderCandidates(state) {
    const section = element('section', 'qqj-v2-candidates');
    section.append(heading('确认要收入档案的人物', '名称和别名可以直接修改；合并只处理你明确选择的一对人物。', 'candidates'));
    const candidates = Array.isArray(state.candidateReview?.candidates) ? state.candidateReview.candidates : [];
    const list = element('div', 'qqj-v2-candidate-list');
    for (const candidate of candidates) {
      const edit = editFor(candidate);
      const card = element('article', 'qqj-v2-candidate');
      const selectId = `qqj-v2-candidate-selected-${++inputCounter}`;
      const choose = element('label', 'qqj-v2-candidate-choice');
      choose.htmlFor = selectId;
      const checkbox = withFocusKey(element('input', 'qqj-v2-checkbox'), `candidate:${candidate.candidateId}:selected`);
      checkbox.id = selectId;
      checkbox.type = 'checkbox';
      checkbox.checked = candidate.selected === true;
      checkbox.disabled = busy;
      listen(checkbox, 'change', () => syncAction(() => flow.setCandidateSelected(candidate.candidateId, checkbox.checked)));
      append(choose, checkbox, element('strong', '', '收入档案'));
      card.append(choose);
      const nameId = `qqj-v2-name-${++inputCounter}`;
      const nameLabel = element('label', 'qqj-v2-field-label', '人物名称');
      nameLabel.htmlFor = nameId;
      const nameInput = withFocusKey(element('input', 'qqj-v2-text-input'), `candidate:${candidate.candidateId}:name`);
      nameInput.id = nameId;
      nameInput.value = edit.name;
      nameInput.disabled = busy;
      listen(nameInput, 'input', () => { edit.name = nameInput.value; });
      const aliasId = `qqj-v2-aliases-${++inputCounter}`;
      const aliasLabel = element('label', 'qqj-v2-field-label', '别名（换行或逗号分隔）');
      aliasLabel.htmlFor = aliasId;
      const aliasInput = withFocusKey(
        element('textarea', 'qqj-v2-textarea qqj-v2-alias-input'),
        `candidate:${candidate.candidateId}:aliases`,
      );
      aliasInput.id = aliasId;
      aliasInput.value = edit.aliases;
      aliasInput.disabled = busy;
      listen(aliasInput, 'input', () => { edit.aliases = aliasInput.value; });
      append(card, nameLabel, nameInput, aliasLabel, aliasInput);
      if (typeof candidate.reason === 'string' && candidate.reason) card.append(element('p', 'qqj-v2-reason', candidate.reason));
      const rowActions = element('div', 'qqj-v2-row-actions');
      rowActions.append(actionButton('保存名称', 'qqj-v2-button qqj-v2-secondary', () => syncAction(() => {
        flow.renameCandidate(candidate.candidateId, edit.name);
        flow.setCandidateAliases(candidate.candidateId, splitAliases(edit.aliases));
        candidateEdits.delete(candidate.candidateId);
      }), busy, `candidate:${candidate.candidateId}:save`));
      rowActions.append(actionButton('移除', 'qqj-v2-button qqj-v2-danger', () => syncAction(() => {
        flow.removeCandidate(candidate.candidateId);
        candidateEdits.delete(candidate.candidateId);
      }), busy, `candidate:${candidate.candidateId}:remove`));
      card.append(rowActions);
      const others = candidates.filter(item => item.candidateId !== candidate.candidateId);
      if (others.length) {
        const mergeLabel = element('label', 'qqj-v2-field-label', '合并到另一人物');
        const mergeId = `qqj-v2-merge-${++inputCounter}`;
        mergeLabel.htmlFor = mergeId;
        const select = withFocusKey(element('select', 'qqj-v2-select'), `candidate:${candidate.candidateId}:merge-target`);
        select.id = mergeId;
        select.disabled = busy;
        const empty = element('option', '', '请选择目标人物');
        empty.value = '';
        select.append(empty);
        for (const target of others) {
          const option = element('option', '', target.displayName);
          option.value = target.candidateId;
          if (edit.targetId === target.candidateId) option.selected = true;
          select.append(option);
        }
        select.value = edit.targetId;
        listen(select, 'change', () => {
          edit.targetId = select.value;
          render({ restoreFocusKey: focusedKey() });
        });
        const mergeButton = actionButton('确认合并', 'qqj-v2-button qqj-v2-secondary', () => syncAction(() => {
          flow.mergeCandidates({ targetId: edit.targetId, sourceIds: [candidate.candidateId] });
          candidateEdits.clear();
        }), busy || !edit.targetId, `candidate:${candidate.candidateId}:merge`);
        append(card, mergeLabel, select, mergeButton);
      }
      list.append(card);
    }
    section.append(list);
    const selected = candidates.filter(candidate => candidate.selected === true).length;
    section.append(element('p', 'qqj-v2-selection-count', `已选择 ${selected} 人`));
    const actions = element('div', 'qqj-v2-actions');
    actions.append(actionButton('返回来源', 'qqj-v2-button qqj-v2-secondary', () => syncAction(() => {
      flow.backToSources(); candidateEdits.clear();
    }), busy, 'candidates:back'));
    actions.append(actionButton('生成基础档案', 'qqj-v2-button qqj-v2-primary', () => runAsync(
      () => {
        profileDrafts.clear();
        return flow.generateProfiles();
      },
      { kind: 'generate' },
    ), busy || selected === 0, 'candidates:generate'));
    section.append(actions);
    return section;
  }

  function renderProfiles(state) {
    const section = element('section', 'qqj-v2-profiles');
    section.append(heading('审核基础档案', 'AI 草稿不会自动保存。请检查文字，确认后才建立正式档案。', 'profiles'));
    const people = Array.isArray(state.profileReview?.people) ? state.profileReview.people : [];
    people.forEach((person, personIndex) => {
      const details = element('details', 'qqj-v2-profile');
      details.open = personIndex === 0;
      details.append(element('summary', '', typeof person.displayName === 'string' ? person.displayName : '未命名人物'));
      const fields = element('div', 'qqj-v2-profile-fields');
      for (const [field, labelText] of Object.entries(FIELD_LABELS)) {
        const id = `qqj-v2-profile-${personIndex}-${field}-${++inputCounter}`;
        const label = element('label', 'qqj-v2-field-label', labelText);
        label.htmlFor = id;
        const textarea = withFocusKey(
          element('textarea', 'qqj-v2-textarea qqj-v2-profile-input'),
          `profile:${person.identityId}:${field}`,
        );
        textarea.id = id;
        const savedValue = typeof person.fields?.[field]?.value === 'string' ? person.fields[field].value : '';
        textarea.value = profileDraft(person.identityId, field, savedValue);
        textarea.disabled = busy;
        textarea.dataset.identityId = person.identityId;
        textarea.dataset.field = field;
        listen(textarea, 'input', () => setProfileDraft(person.identityId, field, textarea.value));
        append(fields, label, textarea);
      }
      details.append(fields);
      section.append(details);
    });
    const actions = element('div', 'qqj-v2-actions');
    actions.append(actionButton('返回人物', 'qqj-v2-button qqj-v2-secondary', () => syncAction(() => {
      flow.backToCandidates();
      profileDrafts.clear();
    }), busy, 'profiles:back'));
    actions.append(actionButton(
      '确认并建立档案',
      'qqj-v2-button qqj-v2-primary',
      () => commitProfiles(),
      busy || people.length === 0,
      'profiles:commit',
    ));
    section.append(actions);
    return section;
  }

  function renderCompleted(state) {
    const section = element('section', 'qqj-v2-completed');
    section.append(heading('档案已经建立', '人物与基础档案已保存。之后可以在千千结中继续整理关系和事件。', 'completed'));
    const order = state.result?.archive?.people?.order;
    section.append(element('p', 'qqj-v2-count', `已建立 ${Array.isArray(order) ? order.length : 0} 人的档案`));
    return section;
  }

  function flowStage() {
    try { return flow.getState(); }
    catch { return { stage: 'idle' }; }
  }

  function render({ restoreFocusKey = '' } = {}) {
    if (!root || destroyed) return;
    clearRenderListeners();
    inputCounter = 0;
    const state = flowStage();
    if (lastFlowStage === 'profiles' && state.stage !== 'profiles') profileDrafts.clear();
    if (lastFlowStage === 'completed' && state.stage !== 'completed') completedNotified = false;
    lastFlowStage = state.stage;
    busy = localBusy || state.busy === true || pendingAction !== null;
    root.setAttribute('aria-busy', busy || readMode === 'loading' ? 'true' : 'false');
    let view;
    let stage = readMode;
    if (memoryMode && readMode === 'memory') { view = renderMemoryState(); stage = `memory-${memoryResult?.status ?? 'error'}`; }
    else if (readMode === 'uninitialized' && state.stage === 'sources') { view = renderSources(state); stage = 'sources'; }
    else if (readMode === 'uninitialized' && state.stage === 'candidates') { view = renderCandidates(state); stage = 'candidates'; }
    else if (readMode === 'uninitialized' && state.stage === 'profiles') { view = renderProfiles(state); stage = 'profiles'; }
    else if (readMode === 'uninitialized' && state.stage === 'completed') { view = renderCompleted(state); stage = 'completed'; }
    else view = renderReadState();
    renderProgress(STEPS.some(([key]) => key === stage) ? stage : 'sources');
    const statusText = statusForState(state);
    const archiveReady = readMode === 'ready';
    root.className = `qqj-v2-initialization${archiveReady && !statusText ? ' is-ready-quiet' : ''}`;
    progress.hidden = archiveReady || progress.children.length === 0;
    status.textContent = statusText;
    status.hidden = !statusText;
    content.replaceChildren(view);
    const stageKey = view.__stageKey || view.__heading?.__stageKey || view.querySelector?.('header')?.__stageKey || stage;
    const stageHeading = view.__heading || view.querySelector?.('header')?.__heading;
    if (active && restoreFocusKey && stageKey === renderedStage) {
      (findFocusTarget(restoreFocusKey) || stageHeading)?.focus?.();
    } else if (active && stageKey !== renderedStage) {
      stageHeading?.focus?.();
    }
    renderedStage = stageKey;
    const result = state.result;
    if (active
      && stage === 'completed'
      && ['created', 'already_initialized'].includes(result?.status)
      && !completedNotified) {
      completedNotified = true;
      try { onCompleted(result); } catch { /* consumer callback is isolated */ }
      try { onArchiveReady(result); } catch { /* consumer callback is isolated */ }
    }
  }

  function handleAsyncResult(result) {
    const message = terminalText(result?.status);
    if (message) errorText = message;
  }

  function observePending(record, token) {
    return record.settled.then(outcome => {
      if (!isCurrent(token)) return outcome.ok ? outcome.result : { status: 'stale' };
      localBusy = false;
      if (outcome.ok) {
        if (record.kind === 'commit'
          && ['created', 'already_initialized'].includes(outcome.result?.status)) {
          profileDrafts.clear();
        }
        handleAsyncResult(outcome.result);
        render({ restoreFocusKey: record.focusKey });
        return outcome.result;
      }
      errorText = safeErrorText(outcome.error);
      render({ restoreFocusKey: record.focusKey });
      return { status: 'error' };
    });
  }

  function runAsync(action, { kind = '' } = {}) {
    const state = flowStage();
    if (localBusy || state.busy === true || pendingAction || !active) {
      return Promise.resolve({ status: 'ignored' });
    }
    const token = epoch;
    const focusKey = focusedKey();
    localBusy = true;
    errorText = '';
    render({ restoreFocusKey: focusKey });
    const record = {
      kind,
      focusKey,
      settled: Promise.resolve().then(action).then(
        result => ({ ok: true, result }),
        error => ({ ok: false, error }),
      ),
    };
    pendingAction = record;
    record.settled.then(() => {
      if (pendingAction === record) pendingAction = null;
    });
    return observePending(record, token);
  }

  function syncAction(action) {
    const state = flowStage();
    if (localBusy || state.busy === true || pendingAction || !active) return;
    const focusKey = focusedKey();
    try {
      errorText = '';
      action();
    } catch (error) {
      errorText = safeErrorText(error);
    }
    render({ restoreFocusKey: focusKey });
  }

  function commitProfiles() {
    const current = flowStage();
    if (localBusy || current.busy === true || pendingAction || !active || !content) return;
    const focusKey = focusedKey();
    try {
      const state = flow.getState();
      const people = Array.isArray(state.profileReview?.people) ? state.profileReview.people : [];
      const byId = new Map(people.map(person => [person.identityId, person]));
      const inputs = content.querySelectorAll('.qqj-v2-profile-input');
      for (const input of inputs) {
        const identityId = input.dataset.identityId;
        const field = input.dataset.field;
        const previous = byId.get(identityId)?.fields?.[field]?.value;
        if (typeof previous === 'string' && input.value !== previous) {
          flow.setProfileField({ identityId, field, value: input.value });
        }
      }
      const identity = composition.currentIdentity();
      runAsync(() => flow.commitInitialization({ identity }), { kind: 'commit' });
    } catch (error) {
      errorText = safeErrorText(error);
      render({ restoreFocusKey: focusKey });
    }
  }

  function mount(container) {
    if (destroyed) throw new Error('视图已经销毁');
    if (!container || (typeof container.append !== 'function' && typeof container.appendChild !== 'function')) {
      throw new TypeError('mount container 无效');
    }
    epoch += 1;
    active = false;
    activationPromise = null;
    localBusy = false;
    busy = false;
    clearRenderListeners();
    dossierView?.invalidate?.();
    root?.remove?.();
    root = element('section', 'qqj-v2-initialization');
    root.hidden = true;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', '千千结初次建档');
    root.setAttribute('aria-busy', 'false');
    const style = element('link', 'qqj-v2-style');
    style.rel = 'stylesheet';
    style.href = new URL('./archive-v2-initialization.css', import.meta.url).href;
    progress = element('nav', 'qqj-v2-progress');
    progress.setAttribute('aria-label', '建档进度');
    status = element('div', 'qqj-v2-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    content = element('div', 'qqj-v2-content');
    append(root, style, progress, status, content);
    if (typeof container.append === 'function') container.append(root); else container.appendChild(root);
    render();
    return root;
  }

  function activate() {
    if (destroyed) return Promise.reject(new Error('视图已经销毁'));
    if (!root) return Promise.reject(new Error('视图尚未挂载'));
    if (active && activationPromise) return activationPromise;
    active = true;
    root.hidden = false;
    const token = ++epoch;
    localBusy = pendingAction !== null || memoryOperationPending() !== null || followedProfileOperationPending() !== null;
    readMode = 'loading';
    readResult = null;
    errorText = '';
    renderedStage = '';
    archiveReadyEpoch = -1;
    render();
    if (pendingAction) void observePending(pendingAction, token);
    if (memoryOperationPending()) startMemoryPolling();
    activationPromise = Promise.resolve().then(() => composition.readArchive()).then(async result => {
      if (!isCurrent(token)) return result;
      readResult = result;
      if (memoryMode && result?.status === 'uninitialized') {
        if (memoryOperationPending()) {
          try { memoryResult = normalizeMemoryResult(memory.getState()); }
          catch { memoryResult = normalizeMemoryResult({ status: 'checking' }); }
          readMode = 'memory';
          localBusy = true;
          startMemoryPolling();
          render();
          return memoryResult;
        }
        let inspected;
        try { inspected = await memory.inspect(); }
        catch { inspected = { status: 'error' }; }
        if (!isCurrent(token)) return inspected;
        memoryResult = normalizeMemoryResult(inspected);
        readMode = 'memory';
        localBusy = memoryOperationPending() !== null;
        if (memoryOperationPending()) startMemoryPolling();
        render();
        return inspected;
      }
      if (['ready', 'uninitialized', 'disabled', 'stale'].includes(result?.status)) readMode = result.status;
      else readMode = 'error';
      if (readMode === 'ready' && followedProfileMode) {
        let inspected;
        try {
          inspected = followedProfileOperationPending()
            ? followedProfiles.getState()
            : await followedProfiles.inspect();
        } catch {
          inspected = { status: 'error' };
        }
        if (!isCurrent(token)) return inspected;
        followedProfileResult = normalizeFollowedProfileResult(inspected);
        localBusy = pendingAction !== null || memoryOperationPending() !== null || followedProfileOperationPending() !== null;
      }
      render();
      if (readMode === 'ready' && archiveReadyEpoch !== token) {
        archiveReadyEpoch = token;
        try { onArchiveReady(result); } catch { /* consumer callback is isolated */ }
      }
      return result;
    }).catch(() => {
      if (!isCurrent(token)) return { status: 'stale' };
      readMode = 'error';
      errorText = '读取档案没有完成，请重新打开此页面。';
      render();
      return { status: 'error' };
    });
    return activationPromise;
  }

  function deactivate() {
    if (!root || destroyed) return;
    active = false;
    epoch += 1;
    activationPromise = null;
    localBusy = false;
    busy = false;
    stopMemoryPolling();
    clearRenderListeners();
    dossierView?.invalidate?.();
    root.hidden = true;
  }

  function destroy() {
    if (destroyed) return;
    active = false;
    destroyed = true;
    epoch += 1;
    activationPromise = null;
    pendingAction = null;
    localBusy = false;
    busy = false;
    stopMemoryPolling();
    memoryStartPromise = null;
    memoryPeoplePromise = null;
    memoryCommitPromise = null;
    memoryResult = null;
    followedProfilePromise = null;
    followedProfileCommitPromise = null;
    followedProfileResult = null;
    memoryPeopleSelection.clear();
    memoryPeopleSelectionKey = '';
    dossierView?.invalidate?.();
    clearRenderListeners();
    candidateEdits.clear();
    profileDrafts.clear();
    root?.remove?.();
    root = null;
    progress = null;
    status = null;
    content = null;
  }

  return Object.freeze({ mount, activate, deactivate, destroy });
}
