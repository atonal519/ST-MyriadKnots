import { createSettingsDrawer } from './settings-drawer.js';
import { MEMORY_PACKAGE_LIMIT } from '../memory-transfer.js';

export function downloadMemoryPackage(file, documentRef = globalThis.document) {
  const windowRef = documentRef.defaultView ?? globalThis;
  const url = windowRef.URL.createObjectURL(new windowRef.Blob([file.text], { type: 'application/json;charset=utf-8' }));
  const link = documentRef.createElement('a'); link.href = url; link.download = file.filename;
  documentRef.body.append(link); link.click(); link.remove();
  windowRef.setTimeout(() => windowRef.URL.revokeObjectURL(url), 60000);
}

export function downloadMemoryVolume(file, documentRef = globalThis.document) {
  const windowRef = documentRef.defaultView ?? globalThis;
  const url = windowRef.URL.createObjectURL(file.blob);
  const link = documentRef.createElement('a'); link.href = url; link.download = file.filename;
  documentRef.body.append(link); link.click(); link.remove();
  return () => windowRef.URL.revokeObjectURL(url);
}

export function createMemoryTransferView({ runtime, documentRef = globalThis.document, confirmImpl = async () => false,
  download = file => downloadMemoryPackage(file, documentRef), downloadVolume = file => downloadMemoryVolume(file, documentRef), open = false, onToggle } = {}) {
  const { drawer, body } = createSettingsDrawer({ documentRef, title: '记忆导入与导出', level: 'sub', id: 'qqj-settings-sub-transfer', className: 'qqj-memory-transfer', open, onToggle });
  const el = (tag, text = '', className = '') => { const node = documentRef.createElement(tag); node.textContent = text; node.className = className; return node; };
  const status = el('p', '', 'settings-result'), preview = el('div'), controls = [];
  const exportCompleteCopy = '导出已完成。请保留清单、全部卷和聊天 JSONL；可重新打开聊天或点“刷新状态”查看记忆。';
  let disposed = false, busy = false, plan = null, epoch = 0, exportSession = null, releaseVolume = null;
  let nextVolumeButton = null, finishVolumeButton = null;
  function updateControls() {
    controls.forEach(node => { node.disabled = busy || exportSession !== null; });
    if (nextVolumeButton) {
      nextVolumeButton.hidden = !exportSession || exportSession.last;
      nextVolumeButton.disabled = busy || !exportSession || exportSession.last || exportSession.cancelled;
      finishVolumeButton.hidden = !exportSession;
      finishVolumeButton.disabled = !exportSession || exportSession.cancelled;
    }
  }
  function releaseCurrentVolume() { releaseVolume?.(); releaseVolume = null; }
  async function stopExport(message = null) {
    const session = exportSession;
    if (!session || session.cancelled) return;
    session.cancelled = true; busy = true; releaseCurrentVolume(); updateControls();
    let resultCopy = message ?? (session.last ? exportCompleteCopy
      : '分卷导出已结束，未完成的文件组不能导入。可重新打开聊天或点“刷新状态”查看记忆。');
    try { await session.iterator.return(); }
    catch (error) { resultCopy = error.message; }
    finally {
      if (exportSession === session) exportSession = null;
      busy = false;
      if (!disposed) { status.textContent = resultCopy; updateControls(); }
    }
  }
  async function advanceVolume() {
    const session = exportSession;
    if (!session || session.cancelled || busy || disposed) return;
    busy = true; releaseCurrentVolume(); updateControls(); status.textContent = '正在生成下一卷，请稍候…';
    try {
      const result = await session.iterator.next();
      if (disposed || session.cancelled || exportSession !== session) return;
      if (result.done) { await stopExport(exportCompleteCopy); return; }
      releaseVolume = downloadVolume(result.value);
      session.last = result.value.manifest === true;
      status.textContent = session.last
        ? '已生成最后的清单。保存完成后点击“结束导出”；清单和全部卷需要一起保留。'
        : `已生成第 ${result.value.part} 卷。请等此卷保存完成，再点击“下载下一卷”。`;
    } catch (error) { await stopExport(error.message); }
    finally { if (!session.cancelled) { busy = false; if (!disposed) updateControls(); } }
  }
  async function action(task) {
    if (busy || disposed || exportSession) return;
    busy = true; updateControls(); status.textContent = '正在读取与核对，请稍候…';
    try { await task(); } catch (error) { if (!disposed) status.textContent = error.message; }
    finally { busy = false; if (!disposed) updateControls(); }
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
  function volumeButton(text, callback) {
    const node = el('button', text, 'secondary-action'); node.type = 'button';
    node.addEventListener('click', () => { if (!node.disabled && !disposed) void callback(); }); return node;
  }
  const startVolumeButton = volumeButton('分卷导出（大记忆）', async () => {
    if (busy || exportSession) return;
    plan = null; preview.replaceChildren(); epoch += 1;
    try { exportSession = { iterator: runtime.exportVolumes(), last: false, cancelled: false }; await advanceVolume(); }
    catch (error) { status.textContent = error.message; updateControls(); }
  });
  controls.push(startVolumeButton);
  nextVolumeButton = volumeButton('下载下一卷', advanceVolume);
  finishVolumeButton = volumeButton('结束导出', () => stopExport());
  body.append(startVolumeButton, el('p', '大档可用分卷导出，总量可超过 1 GB。每卷保存完成后再下载下一卷，最后保存清单。处理时只读取当前卷和单条记录；单条记录特别大时仍需相应内存。', 'settings-hint'), nextVolumeButton, finishVolumeButton);
  const input = el('input', '', 'settings-input'); input.type = 'file'; input.multiple = true; input.accept = '.json,.bin,.qqj-memory.part,application/json,application/octet-stream';
  input.setAttribute('aria-label', '选择千千结记忆包'); controls.push(input);
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []); input.value = ''; if (!files.length || busy || exportSession) return;
    plan = null; preview.replaceChildren(); const token = ++epoch;
    void action(async () => {
      const isManifest = file => /\.qqj-memory\.index\.json$/i.test(file.name ?? '');
      const isPart = file => /\.qqj-memory\.part-\d+\.bin$/i.test(file.name ?? '');
      const volumes = files.length > 1 || files.some(file => isManifest(file) || isPart(file));
      let result;
      if (volumes) {
        if (files.filter(isManifest).length !== 1 || !files.some(isPart) || files.some(file => !isManifest(file) && !isPart(file))) {
          throw new Error('分卷导入请同时选择清单和全部卷；普通 JSON 记忆包请一次选择一个。');
        }
        result = await runtime.previewVolumes(files);
      } else {
        const [file] = files;
        if (file.size > MEMORY_PACKAGE_LIMIT) throw new Error('普通记忆包不能超过 64 MB，请在旧设备使用“分卷导出（大记忆）”。');
        result = await runtime.preview(await file.text());
      }
      if (disposed || token !== epoch) return;
      plan = result;
      preview.append(el('p', `来源：${result.character || '未命名角色'}；${result.messages} 条聊天，${result.summaries} 条摘要，${result.states} 条人物状态变化。`, 'settings-hint'),
        el('p', '聊天内容已核对一致。角色卡更新不会自动改写这些历史记忆。', 'settings-hint'));
      status.textContent = result.replacesMemory ? '当前已有记忆。确认后切换到导入副本，原记忆保留，可撤销本次导入。' : '预览通过，点击“确认导入”恢复。';
    });
  });
  body.append(el('p', '选择一个普通记忆包，或同时选择分卷清单和全部卷。选择后先预览，不会立即写入。', 'settings-hint'), input, preview);
  body.append(button('确认导入', async () => {
    if (!plan) throw new Error('请先选择记忆包并完成预览。');
    const selected = plan, token = epoch;
    const confirmed = await confirmImpl({ title: '恢复当前聊天记忆', body: `将恢复 ${selected.summaries} 条摘要和 ${selected.states} 条人物状态变化。当前记忆会保留为可撤销备份。`, confirmText: '导入记忆', cancelText: '取消' });
    if (!confirmed || disposed || token !== epoch) { if (!disposed) status.textContent = '已取消导入。'; return; }
    const result = await runtime.importPreview(selected); plan = null; preview.replaceChildren();
    if (!disposed) status.textContent = `已恢复 ${result.summaries} 条摘要。请重新打开聊天或刷新页面，让各面板显示导入后的状态。`;
  }), button('撤销上次导入', async () => {
    const confirmed = await confirmImpl({ title: '撤销上次导入', body: '恢复本次导入前的记忆。仅在导入后的记忆和聊天正文均未变化时执行；导入的记忆副本也会保留。', confirmText: '撤销导入', cancelText: '取消' });
    if (!confirmed || disposed) return;
    await runtime.undo(); plan = null; preview.replaceChildren();
    if (!disposed) status.textContent = '已恢复导入前的记忆，请重新打开聊天或刷新页面。';
  }), status);
  updateControls();
  return { node: drawer, dispose() { disposed = true; epoch += 1; plan = null; void stopExport(); } };
}
