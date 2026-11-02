const cleanOptions = options => (Array.isArray(options) ? options : []).map(option => ({
  value: String(option?.value ?? ''),
  label: String(option?.label ?? option?.value ?? ''),
}));

export function createInlineSelect({ documentRef = globalThis.document, options = [], value = '', ariaLabel = '选择', onChange = null, onSelect = null, onFocus = null, searchable = false, searchPlaceholder = '搜索选项', showChevron = true } = {}) {
  if (!documentRef?.createElement) throw new TypeError('inline select documentRef 无效');
  const items = cleanOptions(options);
  const root = documentRef.createElement('div'); root.className = `qqj-inline-select${searchable ? ' qqj-inline-select-searchable' : ''}`;
  const trigger = documentRef.createElement('button'); trigger.type = 'button'; trigger.className = 'settings-input qqj-inline-select-trigger'; trigger.setAttribute('aria-label', ariaLabel); trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
  const label = documentRef.createElement('span'); label.className = 'qqj-inline-select-value';
  const chevron = documentRef.createElement('span'); chevron.className = 'qqj-inline-select-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true');
  const list = documentRef.createElement('div'); list.className = 'qqj-inline-select-options'; list.setAttribute('role', 'listbox'); list.hidden = true;
  const searchPanel = searchable ? documentRef.createElement('div') : null;
  const search = searchable ? documentRef.createElement('input') : null;
  const clear = searchable ? documentRef.createElement('button') : null;
  const empty = searchable ? documentRef.createElement('p') : null;
  if (searchable) {
    searchPanel.className = 'qqj-inline-select-search-panel'; searchPanel.hidden = true;
    const row = documentRef.createElement('div'); row.className = 'qqj-inline-select-search-row';
    search.className = 'settings-input qqj-inline-select-search-input'; search.type = 'search'; search.value = ''; search.placeholder = searchPlaceholder; search.setAttribute('aria-label', searchPlaceholder);
    clear.className = 'secondary-action compact qqj-inline-select-search-clear'; clear.type = 'button'; clear.textContent = '清空'; clear.setAttribute('aria-label', '清空搜索'); clear.setAttribute('title', '清空搜索');
    empty.className = 'settings-hint qqj-inline-select-empty'; empty.textContent = '没有匹配的选项。'; empty.setAttribute('role', 'status'); empty.hidden = true;
    search.addEventListener('input', filterSearch);
    clear.addEventListener('click', event => { event?.preventDefault?.(); event?.stopPropagation?.(); search.value = ''; filterSearch(); search.focus?.({ preventScroll: true }); });
    search.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229 || !['Escape','Enter','ArrowDown','ArrowUp'].includes(event.key)) return;
      event.preventDefault?.(); event.stopPropagation?.();
      if (event.key === 'Escape') { close(); trigger.focus?.({ preventScroll: true }); return; }
      const visible = availableOptions();
      if (event.key === 'Enter') { const selectedButton = optionButtons[items.findIndex(item => item.value === selected)], active = visible.includes(selectedButton) ? selectedButton : visible[0]; if (active) select(items[optionButtons.indexOf(active)].value, true); return; }
      focusOption(event.key === 'ArrowUp' ? visible.at(-1) : visible[0]);
    });
    row.append(search, clear); searchPanel.append(row, list, empty);
  }
  let selected = String(value ?? ''), disabled = false, opened = false, suppressNextClick = false;

  const optionButtons = items.map(option => {
    const button = documentRef.createElement('button'); button.type = 'button'; button.className = 'qqj-inline-select-option'; button.textContent = option.label; button.setAttribute('role', 'option'); button.setAttribute('tabindex', '-1'); button.setAttribute('data-value', option.value);
    let suppressClick = false;
    button.addEventListener('click', event => { event?.stopPropagation?.(); if (suppressClick) { suppressClick = false; return; } if (disabled) return; select(option.value, true); });
    button.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); close(); trigger.focus?.({ preventScroll: true }); return; }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault?.(); event.stopPropagation?.(); suppressClick = true; globalThis.setTimeout?.(() => { suppressClick = false; }, 0); select(option.value, true); return;
      }
      if (!['ArrowDown', 'ArrowUp', ...(searchable ? ['Home', 'End'] : [])].includes(event.key)) return;
      event.preventDefault?.(); event.stopPropagation?.();
      const available = searchable ? availableOptions() : optionButtons, index = available.indexOf(button), offset = event.key === 'ArrowDown' ? 1 : -1;
      const next = event.key === 'Home' ? available[0] : event.key === 'End' ? available.at(-1) : available[(index + offset + available.length) % available.length];
      if (searchable) focusOption(next); else next?.focus?.({ preventScroll: true });
    });
    list.append(button); return button;
  });

  const availableOptions = () => optionButtons.filter(button => !button.hidden && !button.disabled);
  const focusOption = button => { button?.focus?.({ preventScroll: true }); button?.scrollIntoView?.({ block: 'nearest' }); };
  function filterSearch() {
    if (!searchable) return;
    const words = search.value.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    for (let index = 0; index < optionButtons.length; index += 1) optionButtons[index].hidden = !words.every(word => items[index].label.toLocaleLowerCase().includes(word));
    const any = optionButtons.some(button => !button.hidden); empty.hidden = any; list.hidden = !opened || !any; clear.disabled = disabled || !search.value;
  }

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
    if (searchable) { search.disabled = disabled; filterSearch(); }
  }
  function close() { opened = false; list.hidden = true; if (searchPanel) searchPanel.hidden = true; root.classList?.remove?.('open'); trigger.setAttribute('aria-expanded', 'false'); }
  function open() {
    if (disabled) return;
    opened = true; list.hidden = false; root.classList?.add?.('open'); trigger.setAttribute('aria-expanded', 'true');
    if (searchable) { searchPanel.hidden = false; search.value = ''; filterSearch(); search.focus?.({ preventScroll: true }); return; }
    const active = optionButtons[items.findIndex(item => item.value === selected)] ?? optionButtons[0];
    active?.focus?.({ preventScroll: true });
  }
  function select(next, announce = false) {
    const normalized = String(next ?? '');
    if (!items.some(item => item.value === normalized)) return false;
    const changed = normalized !== selected; selected = normalized; sync(); close();
    if (announce && changed) onChange?.(selected);
    if (announce) onSelect?.(selected);
    if (announce) {
      try { trigger.focus?.({ preventScroll: true }); } catch { trigger.focus?.(); }
    }
    return true;
  }
  function setOptionLabel(value, nextLabel) {
    const index = items.findIndex(item => item.value === String(value ?? ''));
    if (index < 0) return false;
    items[index].label = String(nextLabel ?? '');
    optionButtons[index].textContent = items[index].label;
    sync();
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
  root.addEventListener('focusout', event => {
    if (event.relatedTarget && root.contains(event.relatedTarget)) return;
    const focusRoot = root.getRootNode();
    setTimeout(() => { if (!root.contains(focusRoot.activeElement)) close(); }, 0);
  });
  root.append(trigger, searchPanel ?? list); trigger.append(label); if (showChevron) trigger.append(chevron);
  Object.defineProperty(root, 'value', { configurable: true, get: () => selected, set: next => { select(next, false); } });
  Object.defineProperty(root, 'disabled', { configurable: true, get: () => disabled, set: next => { disabled = next === true; if (disabled) close(); sync(); } });
  sync();
  return Object.freeze({ node: root, trigger, list, get value() { return selected; }, setValue: next => select(next, false), setOptionLabel, setDisabled: next => { root.disabled = next; }, open, close });
}
