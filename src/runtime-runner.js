export function createRuntimeRunner({ isEnabled = () => true, orchestrator, people, invalidateDependencies = () => {}, setState = () => {}, mapError = () => '人物识别失败，请稍后重试', disabledState = () => ({ status: 'disabled', pluginEnabled: false }) } = {}) {
  let epoch = 0;
  const invalidResult = mine => !isEnabled() ? disabledState() : mine === epoch ? null : { status: 'stale' };
  const invalidate = () => { epoch += 1; invalidateDependencies(); };
  const run = async () => {
    const mine = epoch, current = () => isEnabled() && mine === epoch;
    if (!current()) return invalidResult(mine) || { status: 'stale' };
    const result = await orchestrator.run();
    if (!current()) return invalidResult(mine) || { status: 'stale' };
    if (['ready', 'route_ready'].includes(result?.status)) {
      const peopleState = await people.getPeople();
      if (!current()) return invalidResult(mine) || { status: 'stale' };
      if (['uninitialized', 'preparing', 'deleting', 'restoring', 'renaming', 'conflict', 'stale'].includes(peopleState.status)) {
        try {
          const identified = await people.identify();
          if (!current() || identified?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
        } catch (error) {
          if (!current()) return invalidResult(mine) || { status: 'stale' };
          const failure = { ...result, people: peopleState, peopleError: mapError(error), peopleRecognitionFailed: true };
          setState(failure); return failure;
        }
      }
    }
    if (!current()) return invalidResult(mine) || { status: 'stale' };
    setState(result); return result;
  };
  return { run, invalidate, getEpoch: () => epoch };
}
