export function scrollManualEditorToTop(anchor) {
  if (!anchor) return false;
  const scroller = anchor.closest('.body');
  if (!scroller) return false;
  const scrollerRect = scroller.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  scroller.scrollTop = Math.max(0, scroller.scrollTop + anchorRect.top - scrollerRect.top);
  return true;
}
