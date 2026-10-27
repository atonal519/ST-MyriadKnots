import { createSettingsDrawer } from './settings-drawer.js';
import { MEMORY_PACKAGE_LIMIT } from '../memory-transfer.js';

export function downloadMemoryPackage(file, documentRef = globalThis.document) {
  const windowRef = documentRef.defaultView ?? globalThis;
  const url = windowRef.URL.createObjectURL(new windowRef.Blob([file.text], { type: 'application/json;charset=utf-8' }));
  const link = documentRef.createElement('a'); link.href = url; link.download = file.filename;
  documentRef.body.append(link); link.click(); link.remove();
  windowRef.setTimeout(() => windowRef.URL.revokeObjectURL(url), 60000);
}

export function createMemoryTransferView({ runtime, documentRef = globalThis.document, confirmImpl = async () => false,
  download = file => downloadMemoryPackage(file, documentRef), open = false, onToggle } = {}) {
  const { drawer, body } = createSettingsDrawer({ documentRef, title: '记忆导入与导出', level: 'sub', id: 'qqj-settings-sub-transfer', className: 'qqj-memory-transfer', open, onToggle });
  const el = (tag, text = '', className = '') => { const node = documentRef.createElement(tag); node.textContent = text; node.className = className; return node; };
  const status = el('p', '', 'settings-result'), preview = el('div'), controls = [];
  let disposed = false, busy = false, plan = null, epoch = 0;
  async function action(task) {
    if (busy || disposed) return;
    busy = true; controls.forEach(node => { node.disabled = true; }); status.textContent = '正在读取与核对，请稍候…';
    try { await task(); } catch (error) { if (!disposed) status.textContent = error.message; }
    finally { busy = false; if (!disposed) controls.forEach(node => { node.disabled = false; }); }
  }
  function button(text, callback) {
    const node = el('button', text, 'secondary-action'); node.type = 'button'; controls.push(node);
    node.addEventListener('click', () => { if (!node.disabled) void action(callback); }); return node;
  }
  body.append(el('p', '换设备时：旧设备导出酒馆聊天（JSONL）和本页的记忆包；新设备先导入并打开同一份聊天，再导入记忆包。包含摘要、人物资料与头像、人物状态、千事和时间记录。文件包含剧情资料，请自行保管；API 密钥与全局设置不随包迁移。', 'settings-hint'));
  body.append(button('导出当前聊天记忆', async () => {
    const file = await runtime.exportCurrent(); if (disposed) return;
    download(file); status.textContent = '记忆包已生成。请同时保留这一刻的酒馆 JSONL 聊天导出文件。';
  }));
  const input = el('input', '', 'settings-input'); input.type = 'file'; input.accept = '.json,.qqj-memory.json,application/json';
  input.setAttribute('aria-label', '选择千千结记忆包'); controls.push(input);
  input.addEventListener('change', () => {
    const file = input.files?.[0]; input.value = ''; if (!file || busy) return;
    plan = null; preview.replaceChildren(); const token = ++epoch;
    void action(async () => {
      if (file.size > MEMORY_PACKAGE_LIMIT) throw new Error('记忆包不能超过 64 MB。');
      const result = await runtime.preview(await file.text()); if (disposed || token !== epoch) return;
      plan = result;
      preview.append(el('p', `来源：${result.character || '未命名角色'}；${result.messages} 条聊天，${result.summaries} 条摘要，${result.states} 条人物状态变化。`, 'settings-hint'),
        el('p', '聊天内容已核对一致。角色卡更新不会自动改写这些历史记忆。', 'settings-hint'));
      status.textContent = result.replacesMemory ? '当前已有记忆。确认后切换到导入副本，原记忆保留，可撤销本次导入。' : '预览通过，点击“确认导入”恢复。';
    });
  });
  body.append(el('p', '选择记忆包后先预览，不会立即写入。', 'settings-hint'), input, preview);
  body.append(button('确认导入', async () => {
    if (!plan) throw new Error('请先选择记忆包并完成预览。');
    const selected = plan, token = epoch;
    const confirmed = await confirmImpl({ title: '恢复当前聊天记忆', body: `将恢复 ${selected.summaries} 条摘要和 ${selected.states} 条人物状态变化。当前记忆会保留为可撤销备份。`, confirmText: '导入记忆', cancelText: '取消' });
    if (!confirmed || disposed || token !== epoch) { if (!disposed) status.textContent = '已取消导入。'; return; }
    const result = await runtime.importPreview(selected); plan = null; preview.replaceChildren();
    if (!disposed) status.textContent = `已恢复 ${result.summaries} 条摘要。请重新打开聊天或刷新页面，让各面板显示导入后的状态。`;
  }), button('撤销上次导入', async () => {
    const confirmed = await confirmImpl({ title: '撤销上次导入', body: '恢复本次导入前的记忆。仅在聊天正文仍一致时执行；导入的记忆副本也会保留。', confirmText: '撤销导入', cancelText: '取消' });
    if (!confirmed || disposed) return;
    await runtime.undo(); plan = null; preview.replaceChildren();
    if (!disposed) status.textContent = '已恢复导入前的记忆，请重新打开聊天或刷新页面。';
  }), status);
  return { node: drawer, dispose() { disposed = true; epoch += 1; plan = null; } };
}
