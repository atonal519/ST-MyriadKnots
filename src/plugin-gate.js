export function createPluginGate({ initiallyEnabled = true, invalidate = () => {}, run = async () => ({ status: 'disabled' }), setUiEnabled = () => {}, disabledState = () => ({ status: 'disabled', pluginEnabled: false }) } = {}) {
  let enabled = initiallyEnabled !== false, enabling = null, generation = 0;
  const setEnabled = async nextValue => {
    const next = nextValue !== false;
    if (next === enabled) return next && enabling ? enabling : (next ? { status: 'unchanged' } : disabledState());
    enabled = next; generation += 1; const mine = generation; invalidate(); setUiEnabled(next);
    if (!next) return disabledState();
    const previous = enabling;
    const task = Promise.resolve(previous).catch(() => {}).then(() => enabled && mine === generation ? run() : disabledState());
    const wrapped = task.finally(() => { if (enabling === wrapped) enabling = null; });
    enabling = wrapped;
    return wrapped;
  };
  return { setEnabled, isEnabled: () => enabled, invalidate: () => invalidate() };
}
