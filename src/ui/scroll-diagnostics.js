const DEFAULT_LIMIT = 24;

const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const rounded = value => Math.round(finite(value));

function targetKind(target) {
  const matches = selector => {
    try { return Boolean(target?.closest?.(selector)); } catch { return false; }
  };
  if (matches('.qqj-profile-switcher')) return 'profile-strip';
  if (matches('.qqj-model-list-items')) return 'model-list';
  if (matches('.source-permission-list')) return 'source-list';
  if (matches('.qqj-inline-select')) return 'inline-select';
  if (matches('.v3-memory-json,.v3-recall-injection')) return 'diagnostic-content';
  if (matches('.qqj-dialog-overlay')) return 'dialog';
  if (matches('textarea')) return 'textarea';
  if (matches('select')) return 'select';
  if (matches('input')) return 'input';
  if (matches('button')) return 'button';
  if (matches('summary')) return 'summary';
  if (matches('[contenteditable="true"]')) return 'editable';
  return 'content';
}

function firstTouch(event) {
  return event?.touches?.[0] ?? event?.changedTouches?.[0] ?? null;
}

export function createScrollDiagnostics({
  target,
  getPage = () => 'unknown',
  windowRef = globalThis,
  navigatorRef = globalThis.navigator,
  maxRecords = DEFAULT_LIMIT,
  now = () => new Date().toISOString(),
  queueMicrotaskRef = globalThis.queueMicrotask?.bind(globalThis) ?? (task => Promise.resolve().then(task)),
} = {}) {
  if (!target?.addEventListener) throw new TypeError('滚动诊断 target 无效');
  const limit = Number.isSafeInteger(maxRecords) && maxRecords > 0 ? maxRecords : DEFAULT_LIMIT;
  const records = [];
  let active = false;
  let gesture = null;

  const measure = () => ({
    scrollTop: rounded(target.scrollTop),
    scrollHeight: rounded(target.scrollHeight),
    clientHeight: rounded(target.clientHeight),
  });
  const style = () => {
    try {
      const computed = windowRef?.getComputedStyle?.(target);
      return { overflowY: String(computed?.overflowY ?? ''), touchAction: String(computed?.touchAction ?? '') };
    } catch { return { overflowY: '', touchAction: '' }; }
  };
  const viewport = () => ({ width: rounded(windowRef?.innerWidth), height: rounded(windowRef?.innerHeight) });
  const observeEvent = (state, event) => {
    state.cancelable ||= event?.cancelable === true;
    queueMicrotaskRef(() => { state.defaultPrevented ||= event?.defaultPrevented === true; });
  };
  const store = state => {
    records.push(Object.freeze(state));
    if (records.length > limit) records.splice(0, records.length - limit);
  };
  const finish = (event, outcome) => {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    const touch = firstTouch(event);
    if (touch) {
      current.dx = rounded(touch.clientX - current.startX);
      current.dy = rounded(touch.clientY - current.startY);
    }
    observeEvent(current, event);
    const endMeasure = measure();
    current.outcome = outcome;
    current.endScrollTop = endMeasure.scrollTop;
    current.endScrollHeight = endMeasure.scrollHeight;
    current.endClientHeight = endMeasure.clientHeight;
    current.endStyle = style();
    queueMicrotaskRef(() => {
      delete current.startX;
      delete current.startY;
      store(current);
    });
  };

  const onTouchStart = event => {
    if (!active || event?.touches?.length !== 1) { gesture = null; return; }
    const touch = firstTouch(event);
    if (!touch) return;
    const startMeasure = measure();
    gesture = {
      recordedAt: now(),
      page: String(getPage?.() ?? 'unknown'),
      target: targetKind(event.target),
      startX: finite(touch.clientX),
      startY: finite(touch.clientY),
      dx: 0,
      dy: 0,
      startScrollTop: startMeasure.scrollTop,
      startScrollHeight: startMeasure.scrollHeight,
      startClientHeight: startMeasure.clientHeight,
      scrollEvent: false,
      cancelable: false,
      defaultPrevented: false,
      qqjSwipeIntercepted: false,
      startStyle: style(),
      viewport: viewport(),
    };
    observeEvent(gesture, event);
  };
  const onTouchMove = event => {
    if (!gesture) return;
    const touch = firstTouch(event);
    if (touch) {
      gesture.dx = rounded(touch.clientX - gesture.startX);
      gesture.dy = rounded(touch.clientY - gesture.startY);
    }
    observeEvent(gesture, event);
  };
  const onTouchEnd = event => finish(event, 'ended');
  const onTouchCancel = event => finish(event, 'cancelled');
  const onScroll = () => { if (gesture) gesture.scrollEvent = true; };
  const listeners = [
    ['touchstart', onTouchStart, { passive: true }],
    ['touchmove', onTouchMove, { passive: true }],
    ['touchend', onTouchEnd, { passive: true }],
    ['touchcancel', onTouchCancel, { passive: true }],
    ['scroll', onScroll, { passive: true }],
  ];

  function start() {
    if (active) return;
    active = true;
    for (const [name, listener, options] of listeners) target.addEventListener(name, listener, options);
  }
  function stop() {
    if (!active) return;
    active = false;
    gesture = null;
    for (const [name, listener, options] of listeners) target.removeEventListener?.(name, listener, options);
  }
  function markQqjSwipeIntercepted() { if (gesture) gesture.qqjSwipeIntercepted = true; }
  function snapshot() {
    return {
      schemaVersion: 1,
      generatedAt: now(),
      userAgent: String(navigatorRef?.userAgent ?? ''),
      collecting: active,
      currentPage: String(getPage?.() ?? 'unknown'),
      records: records.map(record => ({ ...record, startStyle: { ...record.startStyle }, endStyle: { ...record.endStyle }, viewport: { ...record.viewport } })),
    };
  }

  return Object.freeze({ start, stop, markQqjSwipeIntercepted, snapshot });
}
