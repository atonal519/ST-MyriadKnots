export const DESKTOP_PANEL_BREAKPOINT = 641;
export const PANEL_SAFETY_MARGIN = 10;
export const PANEL_MIN_WIDTH = 280;
export const PANEL_MIN_HEIGHT = 300;
export const PANEL_POSITION_KEY = 'qqj-panel-pos-v2';
export const PANEL_SIZE_KEY = 'qqj-panel-size-v2';

const finite = value => Number.isFinite(Number(value));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const viewportSize = (width, height) => ({ width: Math.max(0, Number(width) || 0), height: Math.max(0, Number(height) || 0) });

export function mobilePanelRect(width, height, safeTop = 0, safeBottom = 0) {
  return { left: 10, width: Math.max(0, width - 20), right: 10, top: 20 + safeTop, height: Math.max(0, height - 40 - safeTop - safeBottom), bottom: 20 + safeBottom };
}

export function desktopPanelSize(width, height, saved = null) {
  const viewport = viewportSize(width, height);
  const maximumWidth = Math.max(0, viewport.width - PANEL_SAFETY_MARGIN * 2);
  const maximumHeight = Math.max(0, viewport.height - PANEL_SAFETY_MARGIN * 2);
  const minimumWidth = Math.min(PANEL_MIN_WIDTH, maximumWidth);
  const minimumHeight = Math.min(PANEL_MIN_HEIGHT, maximumHeight);
  const preferredWidth = finite(saved?.width) && Number(saved.width) > 0 ? Number(saved.width) : 360;
  const defaultHeight = Math.min(600, Math.max(0, viewport.height * 0.85));
  const preferredHeight = finite(saved?.height) && Number(saved.height) > 0 ? Number(saved.height) : defaultHeight;
  return {
    width: clamp(preferredWidth, minimumWidth, maximumWidth),
    height: clamp(preferredHeight, minimumHeight, maximumHeight),
    minWidth: minimumWidth,
    minHeight: minimumHeight,
    maxWidth: maximumWidth,
    maxHeight: maximumHeight,
  };
}

export function desktopPanelPosition(width, height, panelWidth, panelHeight, saved = null) {
  const viewport = viewportSize(width, height);
  const availableX = Math.max(0, viewport.width - Math.max(0, Number(panelWidth) || 0));
  const availableY = Math.max(0, viewport.height - Math.max(0, Number(panelHeight) || 0));
  const minimumLeft = Math.min(PANEL_SAFETY_MARGIN, availableX);
  const maximumLeft = Math.max(minimumLeft, availableX - PANEL_SAFETY_MARGIN);
  const minimumTop = Math.min(PANEL_SAFETY_MARGIN, availableY);
  const maximumTop = Math.max(minimumTop, availableY - PANEL_SAFETY_MARGIN);
  const defaultLeft = clamp(availableX - 20, minimumLeft, maximumLeft);
  const defaultTop = clamp(80, minimumTop, maximumTop);
  return {
    left: clamp(finite(saved?.left) ? Number(saved.left) : defaultLeft, minimumLeft, maximumLeft),
    top: clamp(finite(saved?.top) ? Number(saved.top) : defaultTop, minimumTop, maximumTop),
  };
}

function readPreference(storage, key) {
  try {
    const parsed = JSON.parse(storage?.getItem?.(key) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function panelRect(panel) {
  const rect = panel?.getBoundingClientRect?.() || {};
  return {
    left: finite(rect.left) ? Number(rect.left) : Number.parseFloat(panel?.style?.left) || 0,
    top: finite(rect.top) ? Number(rect.top) : Number.parseFloat(panel?.style?.top) || 0,
    width: Number(rect.width) > 0 ? Number(rect.width) : Number(panel?.offsetWidth) || Number.parseFloat(panel?.style?.width) || 0,
    height: Number(rect.height) > 0 ? Number(rect.height) : Number(panel?.offsetHeight) || Number.parseFloat(panel?.style?.height) || 0,
  };
}

export function createPanelGeometryController({ panel, dragHandle, resizeHandle, storage = globalThis.localStorage, viewport = globalThis } = {}) {
  let gesture = null;
  let frame = null;
  let queuedPoint = null;

  const isDesktop = () => Number(viewport?.innerWidth) >= DESKTOP_PANEL_BREAKPOINT;
  const dimensions = () => viewportSize(viewport?.innerWidth, viewport?.innerHeight);
  const writePreference = (key, value) => {
    try { storage?.setItem?.(key, JSON.stringify(value)); } catch { /* UI preference failures must not break the panel. */ }
  };
  const clearFrame = () => {
    if (frame !== null && typeof viewport?.cancelAnimationFrame === 'function') viewport.cancelAnimationFrame(frame);
    frame = null; queuedPoint = null;
  };
  const applyDrag = point => {
    if (!gesture || gesture.kind !== 'drag') return;
    const size = panelRect(panel), view = dimensions();
    const position = desktopPanelPosition(view.width, view.height, size.width, size.height, {
      left: gesture.left + point.x - gesture.startX,
      top: gesture.top + point.y - gesture.startY,
    });
    panel.style.left = `${position.left}px`; panel.style.top = `${position.top}px`; panel.style.right = 'auto';
  };
  const applyResize = point => {
    if (!gesture || gesture.kind !== 'resize') return;
    const view = dimensions();
    const maximumWidth = Math.max(0, view.width - gesture.left - PANEL_SAFETY_MARGIN);
    const maximumHeight = Math.max(0, view.height - gesture.top - PANEL_SAFETY_MARGIN);
    const minimumWidth = Math.min(PANEL_MIN_WIDTH, maximumWidth);
    const minimumHeight = Math.min(PANEL_MIN_HEIGHT, maximumHeight);
    const width = clamp(gesture.width + point.x - gesture.startX, minimumWidth, maximumWidth);
    const height = clamp(gesture.height + point.y - gesture.startY, minimumHeight, maximumHeight);
    panel.style.width = `${width}px`; panel.style.height = `${height}px`;
    panel.style.maxWidth = `${maximumWidth}px`; panel.style.maxHeight = `${maximumHeight}px`;
  };
  const applyQueued = () => {
    const point = queuedPoint; frame = null; queuedPoint = null;
    if (!point) return;
    if (gesture?.kind === 'drag') applyDrag(point);
    else if (gesture?.kind === 'resize') applyResize(point);
  };
  const queue = point => {
    queuedPoint = point;
    if (frame !== null) return;
    if (typeof viewport?.requestAnimationFrame === 'function') frame = viewport.requestAnimationFrame(applyQueued);
    else applyQueued();
  };
  const flush = () => {
    if (!queuedPoint) return;
    if (frame !== null && typeof viewport?.cancelAnimationFrame === 'function') viewport.cancelAnimationFrame(frame);
    applyQueued();
  };
  const releaseCapture = current => {
    try { current?.surface?.releasePointerCapture?.(current.pointerId); } catch { /* Capture may already be lost. */ }
  };
  const finish = ({ persist = false } = {}) => {
    const current = gesture;
    if (!current) return;
    if (persist && current.kind !== 'pending-drag') flush(); else clearFrame();
    gesture = null; panel?.classList?.remove?.('is-gesturing'); panel.style.willChange = '';
    releaseCapture(current);
    if (!persist) return;
    const rect = panelRect(panel);
    if (current.kind === 'drag') writePreference(PANEL_POSITION_KEY, { left: rect.left, top: rect.top });
    if (current.kind === 'resize') writePreference(PANEL_SIZE_KEY, { width: rect.width, height: rect.height });
  };
  const capture = (surface, event) => {
    try { surface?.setPointerCapture?.(event.pointerId); } catch { /* Pointer capture is an enhancement, not a hard dependency. */ }
  };
  const validPrimaryPointer = event => event?.button === undefined || event.button === 0;
  const interactiveTarget = target => Boolean(target?.closest?.('button,a,input,select,textarea,[contenteditable]'));
  const pointOf = event => ({ x: Number(event?.clientX) || 0, y: Number(event?.clientY) || 0 });
  const matchingPointer = event => !gesture || event?.pointerId === undefined || event.pointerId === gesture.pointerId;

  const onDragDown = event => {
    if (!isDesktop() || !validPrimaryPointer(event) || interactiveTarget(event?.target)) return;
    const point = pointOf(event), rect = panelRect(panel);
    gesture = { kind: 'pending-drag', surface: dragHandle, pointerId: event?.pointerId, startX: point.x, startY: point.y, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    capture(dragHandle, event);
  };
  const onDragMove = event => {
    if (!gesture || !['pending-drag', 'drag'].includes(gesture.kind) || !matchingPointer(event)) return;
    if (event?.pointerType === 'mouse' && event.buttons === 0) { finish(); return; }
    const point = pointOf(event);
    if (gesture.kind === 'pending-drag') {
      if (Math.hypot(point.x - gesture.startX, point.y - gesture.startY) <= 5) return;
      gesture.kind = 'drag'; panel.style.left = `${gesture.left}px`; panel.style.top = `${gesture.top}px`; panel.style.right = 'auto';
      panel.style.willChange = 'left, top'; panel?.classList?.add?.('is-gesturing');
    }
    event?.preventDefault?.(); queue(point);
  };
  const onResizeDown = event => {
    if (!isDesktop() || !validPrimaryPointer(event)) return;
    event?.preventDefault?.(); event?.stopPropagation?.();
    const point = pointOf(event), rect = panelRect(panel), view = dimensions();
    const position = desktopPanelPosition(view.width, view.height, rect.width, rect.height, rect);
    panel.style.left = `${position.left}px`; panel.style.top = `${position.top}px`; panel.style.right = 'auto';
    gesture = { kind: 'resize', surface: resizeHandle, pointerId: event?.pointerId, startX: point.x, startY: point.y, left: position.left, top: position.top, width: rect.width, height: rect.height };
    panel.style.willChange = 'width, height'; panel?.classList?.add?.('is-gesturing'); capture(resizeHandle, event);
  };
  const onResizeMove = event => {
    if (!gesture || gesture.kind !== 'resize' || !matchingPointer(event)) return;
    if (event?.pointerType === 'mouse' && event.buttons === 0) { finish(); return; }
    event?.preventDefault?.(); queue(pointOf(event));
  };
  const onPointerUp = event => { if (gesture && matchingPointer(event)) finish({ persist: true }); };
  const onPointerCancel = event => { if (gesture && matchingPointer(event)) finish(); };

  const restore = () => {
    finish();
    if (!panel) return;
    if (!isDesktop()) {
      for (const property of ['left', 'top', 'right', 'bottom', 'width', 'height', 'maxWidth', 'maxHeight', 'transform', 'willChange']) panel.style[property] = '';
      return;
    }
    const view = dimensions(), savedSize = readPreference(storage, PANEL_SIZE_KEY);
    const size = desktopPanelSize(view.width, view.height, savedSize);
    panel.style.width = `${size.width}px`; panel.style.height = `${size.height}px`; panel.style.maxWidth = `${size.maxWidth}px`; panel.style.maxHeight = `${size.maxHeight}px`;
    panel.style.bottom = 'auto'; panel.style.transform = 'none';
    const savedPosition = readPreference(storage, PANEL_POSITION_KEY);
    const position = desktopPanelPosition(view.width, view.height, size.width, size.height, savedPosition);
    panel.style.top = `${position.top}px`;
    if (savedPosition && finite(savedPosition.left) && finite(savedPosition.top)) {
      panel.style.left = `${position.left}px`; panel.style.right = 'auto';
    } else {
      panel.style.left = ''; panel.style.right = `${Math.max(0, view.width - position.left - size.width)}px`;
    }
  };
  const onViewportChange = () => restore();
  const bindings = [
    [dragHandle, 'pointerdown', onDragDown], [dragHandle, 'pointermove', onDragMove], [dragHandle, 'pointerup', onPointerUp], [dragHandle, 'pointercancel', onPointerCancel], [dragHandle, 'lostpointercapture', onPointerCancel],
    [resizeHandle, 'pointerdown', onResizeDown], [resizeHandle, 'pointermove', onResizeMove], [resizeHandle, 'pointerup', onPointerUp], [resizeHandle, 'pointercancel', onPointerCancel], [resizeHandle, 'lostpointercapture', onPointerCancel],
    [viewport, 'resize', onViewportChange], [viewport, 'orientationchange', onViewportChange],
  ];
  for (const [target, name, listener] of bindings) target?.addEventListener?.(name, listener);
  restore();
  return {
    restore,
    cancelGesture: () => finish(),
    destroy() {
      finish();
      for (const [target, name, listener] of bindings) target?.removeEventListener?.(name, listener);
    },
  };
}
