import { createSettingsDrawer } from './settings-drawer.js';
import { MEMORY_PACKAGE_LIMIT } from '../memory-transfer.js';
import { writeMemoryBundle } from '../memory-transfer-bundle.js';
import { prepareMemoryBundleDownload } from './memory-transfer-download.js';

export function downloadMemoryPackage(file, documentRef = globalThis.document) {
  const windowRef = documentRef.defaultView ?? globalThis;
  const url = windowRef.URL.createObjectURL(new windowRef.Blob([file.text], { type: 'application/json;charset=utf-8' }));
  const link = documentRef.createElement('a'); link.href = url; link.download = file.filename;
  documentRef.body.append(link); link.click(); link.remove();
  windowRef.setTimeout(() => windowRef.URL.revokeObjectURL(url), 60000);
}

export function createMemoryTransferView({ runtime, documentRef = globalThis.document, confirmImpl = async () => false,
  download = file => downloadMemoryPackage(file, documentRef), hostDownload,
  prepareBundleDownload = () => prepareMemoryBundleDownload(documentRef.defaultView ?? globalThis, hostDownload), open = false, onToggle } = {}) {
  const { drawer, body } = createSettingsDrawer({ documentRef, title: '记忆导入与导出', level: 'sub', id: 'qqj-settings-sub-transfer', className: 'qqj-memory-transfer', open, onToggle });
  const el = (tag, text = '', className = '') => { const node = documentRef.createElement(tag); node.textContent = text; node.className = className; return node; };
  const status = el('p', '', 'settings-result'), exportStatus = el('p', '', 'settings-result'), preview = el('div'), controls = [];
  for (const node of [status, exportStatus]) { node.setAttribute('role', 'status'); node.setAttribute('aria-live', 'polite'); }
  status.setAttribute('aria-label', '导入与撤销结果'); exportStatus.setAttribute('aria-label', '导出进度');
  let disposed = false, busy = false, plan = null, epoch = 0, exportSession = null;
  let cancelExportButton = null;
  function updateControls() {
    controls.forEach(node => { node.disabled = busy || exportSession !== null; });
    if (cancelExportButton) {
      cancelExportButton.hidden = !exportSession;
      cancelExportButton.disabled = !exportSession || exportSession.cancelled;
    }
  }
  async function stopExport() {
    const session = exportSession;
    if (!session || session.cancelled) return;
    session.cancelled = true; session.controller.abort(); busy = true;
    if (!disposed) exportStatus.textContent = '正在取消导出…';
    updateControls();
    await Promise.allSettled([
      Promise.resolve().then(() => session.iterator?.return()),
      Promise.resolve().then(() => session.target?.abort()),
    ]);
    if (exportSession === session) {
      exportSession = null; busy = false;
      if (!disposed) { exportStatus.textContent = '已取消导出，未完成的记忆包或分卷文件不能导入。'; updateControls(); }
    }
  }
  async function exportBundle() {
    if (busy || exportSession || disposed) return;
    plan = null; preview.replaceChildren(); epoch += 1;
    const session = { controller: new AbortController(), iterator: null, target: null, cancelled: false };
    exportSession = session; busy = true; updateControls(); exportStatus.textContent = '正在准备保存位置…';
    const current = () => !disposed && !session.cancelled && exportSession === session;
    try {
      const target = await prepareBundleDownload();
      if (!current()) { await target.abort(); return; }
      session.target = target;
      const phases = {
        records: ['正在读取记忆记录', '条'], graph: ['正在核验记忆引用', '项'],
        auxiliary: ['正在核验时间、人物与向量记录', '条'], conversation: ['正在核对聊天正文', '条'],
        avatars: ['正在读取人物头像', '张'], verify: ['正在复核存储记录', '条'],
      };
      session.iterator = runtime.exportVolumes({ onProgress: ({ phase, completed, total }) => {
        if (!current()) return;
        exportStatus.textContent = phase === 'manifest' ? '正在生成分卷清单…'
          : `${phases[phase][0]}：${completed}${total == null ? '' : ` / ${total}`} ${phases[phase][1]}…`;
      } });
      exportStatus.textContent = '正在读取与写入记忆包，请稍候…';
      let metadata;
      if (target.mode === 'volumes') {
        metadata = { filename: null, parts: 0, bytes: 0 };
        for await (const file of session.iterator) {
          if (!current()) return;
          exportStatus.textContent = file.manifest ? '正在保存分卷清单…' : `正在保存第 ${file.part} 卷…`;
          await target.saveVolume(file);
          if (!current()) return;
          metadata.bytes += file.blob.size;
          if (file.manifest) metadata.filename = file.filename.replace(/\.index\.json$/i, '');
          else metadata.parts++;
          exportStatus.textContent = file.manifest ? '清单已提交，正在完成导出…' : `已提交第 ${file.part} 卷，正在继续导出…`;
        }
      } else {
        metadata = await writeMemoryBundle(session.iterator, target.writable, { signal: session.controller.signal,
          onProgress: progress => { if (current()) exportStatus.textContent = progress.manifest
            ? '已写入清单，正在完成记忆包…' : `已写入第 ${progress.part} 卷，正在继续导出…`; } });
      }
      if (!current()) return;
      exportStatus.textContent = '正在完成保存，请稍候…';
      const result = await target.finish(metadata);
      if (current()) exportStatus.textContent = result?.delivered === false ? result.message ?? '已取消导出。'
        : `${result?.message ?? (target.mode === 'volumes'
          ? '已提交全部分卷下载，请允许连续下载并保留清单和全部卷。' : '大记忆包已保存。')}请同时保留这一刻的酒馆 JSONL 聊天导出文件。`;
    } catch (error) {
      if (current()) exportStatus.textContent = error?.name === 'AbortError' ? '已取消导出。' : error.message;
      if (!session.cancelled) { try { await session.target?.abort(); } catch { /* Preserve the original export failure. */ } }
    } finally {
      if (exportSession === session && !session.cancelled) {
        exportSession = null; busy = false;
        if (!disposed) updateControls();
      }
    }
  }
  async function action(task, output = status) {
    if (busy || disposed || exportSession) return;
    busy = true; updateControls(); output.textContent = '正在读取与核对，请稍候…';
    try { await task(); } catch (error) { if (!disposed) output.textContent = error.message; }
    finally { busy = false; if (!disposed) updateControls(); }
  }
  function button(text, callback, output = status) {
    const node = el('button', text, 'secondary-action'); node.type = 'button'; controls.push(node);
    node.addEventListener('click', () => { if (!node.disabled) void action(callback, output); }); return node;
  }
  body.append(el('p', '换设备时：旧设备导出酒馆聊天（JSONL）和本页的记忆包；新设备先导入并打开同一份聊天，再导入记忆包。包含摘要、人物资料与头像、人物状态、千事和时间记录。文件包含剧情资料，请自行保管；API 密钥与全局设置不随包迁移。', 'settings-hint'));
  body.append(button('导出当前聊天记忆', async () => {
    const file = await runtime.exportCurrent(); if (disposed) return;
    download(file); exportStatus.textContent = '记忆包已生成。请同时保留这一刻的酒馆 JSONL 聊天导出文件。';
  }, exportStatus));
  function volumeButton(text, callback) {
    const node = el('button', text, 'secondary-action'); node.type = 'button';
    node.addEventListener('click', () => { if (!node.disabled && !disposed) void callback(); }); return node;
  }
  const startVolumeButton = volumeButton('自动导出大记忆包', exportBundle);
  controls.push(startVolumeButton);
  cancelExportButton = volumeButton('取消导出', stopExport);
  body.append(startVolumeButton, cancelExportButton, exportStatus, el('p', '自动顺序导出，可处理超过 1 GB 的记忆。支持时保存为一个 .qqj-memory 文件；其他环境自动下载各卷及最后的清单，可能需要允许连续下载。无需逐卷点击，按小批读取与保存，不会将整个记忆包载入内存。', 'settings-hint'));
  const input = el('input', '', 'settings-input'); input.type = 'file'; input.multiple = true; input.accept = '.qqj-memory,.json,.bin,.qqj-memory.part,application/json,application/octet-stream';
  input.setAttribute('aria-label', '选择千千结记忆包'); controls.push(input);
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []); input.value = ''; if (!files.length || busy || exportSession) return;
    plan = null; preview.replaceChildren(); const token = ++epoch;
    void action(async () => {
      const isManifest = file => /\.qqj-memory\.index\.json$/i.test(file.name ?? '');
      const isPart = file => /\.qqj-memory\.part-\d+\.bin$/i.test(file.name ?? '');
      const isBundle = file => /\.qqj-memory$/i.test(file.name ?? '');
      const volumes = files.length > 1 || files.some(file => isManifest(file) || isPart(file));
      let result;
      if (files.some(isBundle)) {
        if (files.length !== 1) throw new Error('单个大记忆包请一次选择一个。');
        result = await runtime.previewVolumes(files);
      } else if (volumes) {
        if (files.filter(isManifest).length !== 1 || !files.some(isPart) || files.some(file => !isManifest(file) && !isPart(file))) {
          throw new Error('分卷导入请同时选择清单和全部卷；普通 JSON 记忆包请一次选择一个。');
        }
        result = await runtime.previewVolumes(files);
      } else {
        const [file] = files;
        if (file.size > MEMORY_PACKAGE_LIMIT) throw new Error('普通记忆包不能超过 64 MB，请在旧设备使用“自动导出大记忆包”。');
        result = await runtime.preview(await file.text());
      }
      if (disposed || token !== epoch) return;
      plan = result;
      preview.append(el('p', `来源：${result.character || '未命名角色'}；${result.messages} 条聊天，${result.summaries} 条摘要，${result.states} 条人物状态变化。`, 'settings-hint'),
        el('p', '聊天内容已核对一致。角色卡更新不会自动改写这些历史记忆。', 'settings-hint'));
      status.textContent = result.replacesMemory ? '当前已有记忆。确认后切换到导入副本，原记忆保留，可撤销本次导入。' : '预览通过，点击“确认导入”恢复。';
    });
  });
  body.append(el('p', '选择一个普通记忆包、一个 .qqj-memory 大记忆包，或同时选择旧分卷清单和全部卷。选择后先预览，不会立即写入。', 'settings-hint'), input, preview, status);
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
  }));
  updateControls();
  return { node: drawer, dispose() { disposed = true; epoch += 1; plan = null; void stopExport(); } };
}
