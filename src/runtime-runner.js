export function createRuntimeRunner({ isEnabled = () => true, orchestrator, people, stableFloors, peopleFoundation, initialRelations, invalidateDependencies = () => {}, setState = () => {}, mapError = () => '人物识别失败，请稍后重试', disabledState = () => ({ status: 'disabled', pluginEnabled: false }) } = {}) {
  let epoch = 0;
  const invalidResult = mine => !isEnabled() ? disabledState() : mine === epoch ? null : { status: 'stale' };
  const invalidate = () => { epoch += 1; invalidateDependencies(); };
  const run = async () => {
    const mine = epoch, current = () => isEnabled() && mine === epoch;
    if (!current()) return invalidResult(mine) || { status: 'stale' };
    const result = await orchestrator.run();
    if (!current()) return invalidResult(mine) || { status: 'stale' };
    let peopleState = null;
    if (['ready', 'route_ready'].includes(result?.status)) {
      peopleState = await people.getPeople();
      if (!current()) return invalidResult(mine) || { status: 'stale' };
      if (['uninitialized', 'preparing', 'deleting', 'restoring', 'renaming', 'conflict', 'stale'].includes(peopleState.status)) {
        try {
          const identified = await people.identify();
          if (!current() || identified?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
          peopleState = await people.getPeople();
          if (!current()) return invalidResult(mine) || { status: 'stale' };
          if (Array.isArray(identified?.warnings)) peopleState = { ...peopleState, warnings: identified.warnings };
        } catch (error) {
          if (!current()) return invalidResult(mine) || { status: 'stale' };
          const failure = { ...result, people: peopleState, peopleError: mapError(error), peopleRecognitionFailed: true };
          setState(failure); return failure;
        }
      }
    }
    if (!current()) return invalidResult(mine) || { status: 'stale' };
    let finalResult = peopleState ? { ...result, people: peopleState } : result;
    if (typeof stableFloors?.refresh === 'function' && ['migrated', 'awaiting_card_type', 'ready', 'route_ready', 'route_unavailable'].includes(result?.status)) {
      const stableFloorState = await stableFloors.refresh();
      if (!current() || stableFloorState?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
      finalResult = { ...finalResult, stableFloors: stableFloorState };
    }
    if (typeof peopleFoundation?.initialize === 'function' && ['ready', 'route_ready', 'route_unavailable'].includes(result?.status)) {
      const foundationState = await peopleFoundation.initialize({ stableFloorState: finalResult.stableFloors });
      if (!current() || foundationState?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
      finalResult = { ...finalResult, peopleFoundation: foundationState };
    }
    if (typeof initialRelations?.resume === 'function' && finalResult.peopleFoundation?.status === 'ready') {
      const foundationInitial = finalResult.peopleFoundation?.state?.initialGeneration;
      const beforeResume = foundationInitial && typeof foundationInitial === 'object'
        ? foundationInitial
        : typeof initialRelations.getState === 'function' ? initialRelations.getState() : null;
      if (beforeResume) finalResult = { ...finalResult, initialRelations: beforeResume };
      if (['applying', 'generating'].includes(beforeResume?.status) && current()) setState(finalResult);
      const initialRelationState = await initialRelations.resume();
      if (!current() || initialRelationState?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
      const persisted = typeof initialRelations.getState === 'function' ? initialRelations.getState() : null;
      finalResult = { ...finalResult, initialRelations: { ...(persisted || {}), ...initialRelationState } };
    }
    if (!current()) return invalidResult(mine) || { status: 'stale' };
    setState(finalResult); return finalResult;
  };
  return { run, invalidate, getEpoch: () => epoch };
}
