export function bindHorizontalStrip(strip) {
  let pointer = null, suppressClick = false;
  const maximum = () => Math.max(0, strip.scrollWidth - strip.clientWidth);
  const finish = event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const captured = pointer.moved, pointerId = pointer.id;
    suppressClick = captured && event.type === 'pointerup'; pointer = null; strip.classList.remove('dragging');
    if (captured && event.type !== 'lostpointercapture') try { strip.releasePointerCapture(pointerId); } catch { /* capture may already be released */ }
  };
  strip.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || maximum() <= 0) return;
    pointer = { id: event.pointerId, x: event.clientX, scrollLeft: strip.scrollLeft, moved: false };
  });
  strip.addEventListener('pointermove', event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const distance = event.clientX - pointer.x;
    if (!pointer.moved && Math.abs(distance) < 4) return;
    pointer.moved = true; strip.setPointerCapture(pointer.id); strip.classList.add('dragging'); event.preventDefault();
    strip.scrollLeft = Math.max(0, Math.min(maximum(), pointer.scrollLeft - distance));
  });
  strip.addEventListener('pointerup', finish);
  strip.addEventListener('pointercancel', finish);
  strip.addEventListener('lostpointercapture', finish);
  strip.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  strip.addEventListener('wheel', event => {
    if (!event.deltaY || event.deltaX || maximum() <= 0) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
    const before = strip.scrollLeft;
    strip.scrollLeft = Math.max(0, Math.min(maximum(), before + event.deltaY * scale));
    if (strip.scrollLeft !== before) event.preventDefault();
  }, { passive: false });
  return strip;
}

export function openPeopleOrderDialog({ customImpl, runtime, people, documentRef, chatId, onSaved } = {}) {
  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const orderedIds = people.map(person => person.entityId);
  const panel = element('section', 'qqj-people-order-dialog');
  panel.append(element('p', 'qqj-people-order-intro', '按住抓手上下拖动。保存后，千人和双丝网会使用同一人物顺序。'));
  const list = element('div', 'qqj-people-order-list');
  const rows = new Map();
  const renderRows = () => list.replaceChildren(...orderedIds.map(entityId => rows.get(entityId)));
  const move = (entityId, targetIndex) => {
    const currentIndex = orderedIds.indexOf(entityId);
    if (currentIndex < 0 || targetIndex < 0) return;
    let insertionIndex = targetIndex;
    if (currentIndex < insertionIndex) insertionIndex -= 1;
    if (insertionIndex === currentIndex) return;
    orderedIds.splice(currentIndex, 1); orderedIds.splice(Math.min(insertionIndex, orderedIds.length), 0, entityId); renderRows();
  };
  let drag = null;
  for (const person of people) {
    const row = element('div', 'qqj-people-order-row');
    const handle = element('button', 'qqj-people-order-handle', '⋮⋮');
    handle.type = 'button'; handle.setAttribute('aria-label', `拖动调整${person.displayName || person.entityDisplayName || '人物'}的顺序`); handle.setAttribute('title', '按住上下拖动排序');
    row.append(handle, element('span', 'qqj-people-order-name', person.displayName || person.entityDisplayName || '未命名人物'));
    rows.set(person.entityId, row);
    handle.addEventListener('pointerdown', event => {
      if (event.button !== undefined && event.button !== 0) return;
      drag = { pointerId: event.pointerId, entityId: person.entityId, row }; list.setPointerCapture(event.pointerId); row.classList.add('dragging'); event.preventDefault();
    });
  }
  list.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    const bounds = list.getBoundingClientRect();
    const edge = Math.min(36, bounds.height / 4);
    if (event.clientY < bounds.top + edge) list.scrollTop = Math.max(0, list.scrollTop - 24);
    else if (event.clientY > bounds.bottom - edge) list.scrollTop = Math.min(Math.max(0, list.scrollHeight - list.clientHeight), list.scrollTop + 24);
    const targetIndex = orderedIds.findIndex(entityId => {
      const rect = rows.get(entityId).getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    move(drag.entityId, targetIndex < 0 ? orderedIds.length : targetIndex);
  });
  const finishDrag = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const current = drag; drag = null; current.row.classList.remove('dragging');
    if (event.type !== 'lostpointercapture') try { list.releasePointerCapture(current.pointerId); } catch { /* capture may already be released */ }
  };
  list.addEventListener('pointerup', finishDrag); list.addEventListener('pointercancel', finishDrag); list.addEventListener('lostpointercapture', finishDrag);
  renderRows(); panel.append(list);
  return customImpl({ title: '人物排序', content: panel, confirmText: '保存顺序', cancelText: '取消', submit: async () => {
    if ((runtime.getState().chatId ?? null) !== (chatId ?? null)) throw new Error('聊天已变化，本次人物顺序没有保存。');
    const result = await runtime.setPersonOrderEntityIds(orderedIds);
    if ((result.chatId ?? null) !== (chatId ?? null)) throw new Error('聊天已变化，本次人物顺序没有应用到当前页面。');
    if (onSaved) onSaved(result);
    return true;
  } });
}
