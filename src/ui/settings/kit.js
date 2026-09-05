// 设置模块共用的小工具：DOM 帮手 + 一个 sub 级抽屉外壳。
import { createSettingsDrawer } from '../settings-drawer.js';

export function createSettingsKit(documentRef = globalThis.document) {
  const element = (tag, className = '', text = '') => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  };
  const button = (text, className, action) => {
    const node = element('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const field = (label, control) => {
    const node = element('label', 'settings-field');
    node.append(element('span', '', label), control);
    return node;
  };
  const appendOption = (select, value, text) => {
    const option = element('option', '', text);
    option.value = value;
    select.append(option);
    return option;
  };
  const subDrawer = ({ title, id = '', open = false, onToggle } = {}) =>
    createSettingsDrawer({ documentRef, title, id, open, level: 'sub', onToggle });
  return { element, button, field, appendOption, subDrawer };
}
