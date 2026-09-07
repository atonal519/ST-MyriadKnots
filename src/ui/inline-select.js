const cleanOptions = options => (Array.isArray(options) ? options : []).map(option => ({
  value: String(option?.value ?? ''),
  label: String(option?.label ?? option?.value ?? ''),
}));

export function createInlineSelect({ documentRef = globalThis.document, options = [], value = '', ariaLabel = '选择', onChange = null, onFocus = null } = {}) {
  if (!documentRef?.createElement) throw new TypeError('inline select documentRef 无效');
  const items = cleanOptions(options);
  const root = documentRef.createElement('div'); root.className = 'qqj-inline-select';
  const trigger = documentRef.createElement('button'); trigger.type = 'button'; trigger.className = 'settings-input qqj-inline-select-trigger'; trigger.setAttribute('aria-label', ariaLabel); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
  const label = documentRef.createElement('span'); label.className = 'qqj-inline-select-value';
  const chevron = documentRef.createElement('span'); chevron.className = 'qqj-inline-select-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true');
  const list = documentRef.createElement('div'); list.className = 'qqj-inline-select-options'; list.setAttribute('role', 'listbox'); list.hidden = true;
  let selected = String(value ?? ''), disabled = false, opened = false, suppressNextClick = false;

  const optionButtons = items.map(option => {
    const button = documentRef.createElement('button'); button.type = 'button'; button.className = 'qqj-inline-select-option'; button.textContent = option.label; button.setAttribute('role', 'option'); button.setAttribute('data-value', option.value);
    let suppressClick = false;
    button.addEventListener('click', event => { event?.stopPropagation?.(); if (suppressClick) { suppressClick = false; return; } if (disabled) return; select(option.value, true); });
    button.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); close(); trigger.focus?.({ preventScroll: true }); return; }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault?.(); event.stopPropagation?.(); suppressClick = true; globalThis.setTimeout?.(() => { suppressClick = false; }, 0); select(option.value, true); return;
      }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault?.(); event.stopPropagation?.();
      const index = optionButtons.indexOf(button), offset = event.key === 'ArrowDown' ? 1 : -1;
      optionButtons[(index + offset + optionButtons.length) % optionButtons.length]?.focus?.({ preventScroll: true });
    });
    list.append(button); return button;
  });

  function sync() {
    const option = items.find(item => item.value === selected) ?? items[0] ?? { value: '', label: '无可选项' };
    if (!items.some(item => item.value === selected)) selected = option.value;
    label.textContent = option.label;
    for (let index = 0; index < optionButtons.length; index += 1) {
      const active = items[index].value === selected;
      optionButtons[index].className = `qqj-inline-select-option${active ? ' active' : ''}`;
      optionButtons[index].setAttribute('aria-selected', String(active));
      optionButtons[index].disabled = disabled;
    }
    trigger.disabled = disabled;
  }
  function close() { opened = false; list.hidden = true; root.classList?.remove?.('open'); trigger.setAttribute('aria-expanded', 'false'); }
  function open() {
    if (disabled) return;
    opened = true; list.hidden = false; root.classList?.add?.('open'); trigger.setAttribute('aria-expanded', 'true');
    const active = optionButtons[items.findIndex(item => item.value === selected)] ?? optionButtons[0];
    active?.focus?.({ preventScroll: true });
  }
  function select(next, announce = false) {
    const normalized = String(next ?? '');
    if (!items.some(item => item.value === normalized)) return false;
    const changed = normalized !== selected; selected = normalized; sync(); close();
    if (announce && changed) onChange?.(selected);
    if (announce) {
      try { trigger.focus?.({ preventScroll: true }); } catch { trigger.focus?.(); }
    }
    return true;
  }
  trigger.addEventListener('focus', () => onFocus?.());
  trigger.addEventListener('click', event => { event?.stopPropagation?.(); if (suppressNextClick) { suppressNextClick = false; return; } if (opened) close(); else open(); });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); close(); return; }
    if (!['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault?.(); event.stopPropagation?.();
    if (event.key === 'Enter' || event.key === ' ') { suppressNextClick = true; globalThis.setTimeout?.(() => { suppressNextClick = false; }, 0); }
    open();
  });
  root.addEventListener('focusout', event => { if (!root.contains?.(event.relatedTarget)) close(); });
  root.append(trigger, list); trigger.append(label, chevron);
  Object.defineProperty(root, 'value', { configurable: true, get: () => selected, set: next => { select(next, false); } });
  Object.defineProperty(root, 'disabled', { configurable: true, get: () => disabled, set: next => { disabled = next === true; if (disabled) close(); sync(); } });
  sync();
  return Object.freeze({ node: root, trigger, list, get value() { return selected; }, setValue: next => select(next, false), setDisabled: next => { root.disabled = next; }, open, close });
}
