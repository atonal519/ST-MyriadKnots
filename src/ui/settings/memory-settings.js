import { createSettingsKit } from './kit.js';

// 记忆设置：只承载“每 N 楼提取一次记忆”（记忆提取周期）。开关由主开关统管，无独立开关。
export function createMemorySettings({ settings, documentRef = globalThis.document, open = false, onToggle, onAutomationChange } = {}) {
  const { element, field, subDrawer } = createSettingsKit(documentRef);
  const { drawer, body } = subDrawer({ title: '记忆提取周期', id: 'qqj-settings-memory-period', open, onToggle });

  const batch = element('input', 'settings-input settings-num');
  batch.type = 'number'; batch.min = '1'; batch.max = '20'; batch.step = '1';
  batch.value = String(settings.get().autoMemoryBatchSize ?? 2);
  const result = element('p', 'settings-result');

  const apply = async () => {
    const previous = settings.get().autoMemoryBatchSize;
    batch.disabled = true;
    result.textContent = ''; result.className = 'settings-result';
    try {
      const saved = settings.update({ autoMemoryBatchSize: Number(batch.value) });
      batch.value = String(saved.autoMemoryBatchSize);
      await onAutomationChange?.();
    } catch (error) {
      settings.update({ autoMemoryBatchSize: previous });
      batch.value = String(previous);
      result.textContent = `保存失败，已恢复：${error?.message || '未知错误'}`;
      result.className = 'settings-result error';
    } finally {
      batch.disabled = false;
    }
  };
  batch.addEventListener('change', apply);

  body.append(field('每 N 楼提取一次记忆', batch), result);
  return { node: drawer };
}
