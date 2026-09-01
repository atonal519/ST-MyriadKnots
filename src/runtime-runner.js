export function createRuntimeRunner({ isEnabled = () => true, orchestrator, people, sourceCatalog, stableFloors, peopleFoundation, initialRelations, invalidateDependencies = () => {}, setState = () => {}, mapError = () => '人物识别失败，请稍后重试', disabledState = () => ({ status: 'disabled', pluginEnabled: false }) } = {}) {
  let epoch = 0, activeFlight = null;
  const phaseLabels = Object.freeze({ reading_sources: '正在读取路线来源', waiting_ai: '正在等待 AI 识别', saving_people: '正在写入人物档案' });
  const runtimeIssue = (stage, code) => ({ stage, code, retryable: true });
  const invalidResult = mine => !isEnabled() ? disabledState() : mine === epoch ? null : { status: 'stale' };
  const invalidate = () => { epoch += 1; invalidateDependencies(); };
  const run = ({ setState: scopedSetState, isCurrent: scopedCurrent, allowIdentification = false, retryRecognition = false } = {}) => {
    const mine = epoch;
    const caller = {
      setState: typeof scopedSetState === 'function' ? scopedSetState : setState,
      isCurrent: typeof scopedCurrent === 'function' ? scopedCurrent : null,
      foreground: typeof scopedSetState === 'function' || typeof scopedCurrent === 'function',
    };
    if (!isEnabled()) return Promise.resolve(invalidResult(mine) || { status: 'stale' });
    if (activeFlight?.epoch === mine) {
      const joinedFlight = activeFlight;
      if (caller.foreground || !joinedFlight.owner?.foreground) joinedFlight.owner = caller;
      if (allowIdentification) {
        const upgraded = !joinedFlight.allowIdentification;
        joinedFlight.allowIdentification = true;
        joinedFlight.retryRecognition ||= retryRecognition;
        if (upgraded && !joinedFlight.followup) {
          joinedFlight.followup = joinedFlight.promise.then(result => joinedFlight.identificationIntentHandled
            ? result
            : run({ setState: scopedSetState, isCurrent: scopedCurrent, allowIdentification: true, retryRecognition }));
        }
        if (joinedFlight.followup) return joinedFlight.followup;
      }
      return joinedFlight.promise;
    }
    const flight = { epoch: mine, owner: caller, promise: null, allowIdentification, retryRecognition, identificationIntentHandled: false, followup: null };
    const current = () => isEnabled() && mine === epoch;
    const publish = value => {
      if (!current()) return false;
      const target = flight.owner;
      if (!target || (typeof target.isCurrent === 'function' && !target.isCurrent())) return false;
      target.setState(value); return true;
    };
    flight.promise = (async () => {
      if (!current()) return invalidResult(mine) || { status: 'stale' };
      const result = await orchestrator.run();
      if (!current()) return invalidResult(mine) || { status: 'stale' };
      const runtimeSnapshot = { formalState: result };
      let peopleState = null;
      let sourceCatalogState = null;
      if (['ready', 'route_ready'].includes(result?.status)) {
        peopleState = await people.getPeople({ runtimeSnapshot });
        if (!current()) return invalidResult(mine) || { status: 'stale' };
        const recognitionPending = ['uninitialized', 'preparing', 'deleting', 'restoring', 'renaming', 'conflict', 'stale'].includes(peopleState.status);
        const manualLegacyRefresh = peopleState?.status === 'ready' && peopleState.refreshRecommended === true && flight.allowIdentification;
        if (recognitionPending || manualLegacyRefresh) {
          if (typeof sourceCatalog?.getState === 'function') {
            sourceCatalogState = await sourceCatalog.getState({ formalState: result });
            if (!current() || sourceCatalogState?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
          }
          const catalogControlled = typeof sourceCatalog?.getState === 'function';
          if (catalogControlled && !flight.allowIdentification) {
            peopleState = { ...peopleState, recognitionRequired: true };
          } else {
            let claim = null;
            if (catalogControlled) {
              flight.identificationIntentHandled = true;
              if (flight.retryRecognition && typeof sourceCatalog?.retry === 'function') {
                sourceCatalogState = await sourceCatalog.retry();
                if (!current() || sourceCatalogState?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
              }
              claim = await sourceCatalog?.claimRecognition?.();
              if (!current() || claim?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
              if (claim?.status !== 'claimed') {
                sourceCatalogState = claim?.catalog || await sourceCatalog.getState({ formalState: result });
                if (!manualLegacyRefresh) peopleState = { ...peopleState, recognitionRequired: true };
              }
            }
            if (!catalogControlled || claim?.status === 'claimed') {
          try {
            const identified = await people.identify({
              runtimeSnapshot,
              ...(claim?.status === 'claimed' ? { sourceCatalogClaim: claim } : {}),
              onPhase: phase => {
                if (!phaseLabels[phase]) return;
                publish({ ...result, status: phase, people: peopleState, sourceCatalog: sourceCatalogState, runtimePhase: { code: phase, label: phaseLabels[phase] } });
              },
            });
            if (!current() || identified?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
            peopleState = await people.getPeople({ runtimeSnapshot });
            if (!current()) return invalidResult(mine) || { status: 'stale' };
            if (Array.isArray(identified?.warnings)) peopleState = { ...peopleState, warnings: identified.warnings };
            if (claim?.status === 'claimed') {
              if (peopleState?.status === 'ready') sourceCatalogState = await sourceCatalog.completeRecognition({ operationId: claim.operationId });
              else sourceCatalogState = await sourceCatalog.failRecognition({ operationId: claim.operationId, errorCode: `people_${peopleState?.status || 'unavailable'}` });
              if (!current() || sourceCatalogState?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
            }
          } catch (error) {
            if (!current()) return invalidResult(mine) || { status: 'stale' };
            if (claim?.status === 'claimed') {
              try { sourceCatalogState = await sourceCatalog.failRecognition({ operationId: claim.operationId, errorCode: error?.code || 'identify_failed' }); }
              catch { /* the original recognition failure remains authoritative */ }
            }
            const failure = { ...result, people: peopleState, sourceCatalog: sourceCatalogState, peopleError: mapError(error), peopleRecognitionFailed: true, runtimeIssue: runtimeIssue('people_recognition', 'identify_failed') };
            publish(failure); return failure;
          }
          if (peopleState?.status !== 'ready') {
            const failure = { ...result, people: peopleState, sourceCatalog: sourceCatalogState, peopleError: peopleState?.peopleError || '人物识别尚未完成，请重试', peopleRecognitionFailed: true, runtimeIssue: runtimeIssue('people_recognition', `people_${peopleState?.status || 'unavailable'}`) };
            publish(failure); return failure;
          }
            }
          }
        }
      }
      if (!current()) return invalidResult(mine) || { status: 'stale' };
      let finalResult = peopleState ? { ...result, people: peopleState, ...(sourceCatalogState ? { sourceCatalog: sourceCatalogState } : {}) } : result;
      if (typeof stableFloors?.refresh === 'function' && ['migrated', 'awaiting_card_type', 'ready', 'route_ready', 'route_unavailable'].includes(result?.status)) {
        const stableFloorState = await stableFloors.refresh();
        if (!current() || stableFloorState?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
        finalResult = { ...finalResult, stableFloors: stableFloorState };
      }
      if (typeof peopleFoundation?.initialize === 'function' && peopleState?.status === 'ready' && ['ready', 'route_ready', 'route_unavailable'].includes(result?.status)) {
        const foundationState = await peopleFoundation.initialize({ stableFloorState: finalResult.stableFloors });
        if (!current() || foundationState?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
        finalResult = { ...finalResult, peopleFoundation: foundationState };
        if (foundationState?.status !== 'ready') finalResult = { ...finalResult, runtimeIssue: runtimeIssue('people_foundation', `foundation_${foundationState?.status || 'unavailable'}`) };
      }
      if (typeof initialRelations?.resume === 'function' && finalResult.peopleFoundation?.status === 'ready') {
        const foundationInitial = finalResult.peopleFoundation?.state?.initialGeneration;
        const beforeResume = foundationInitial && typeof foundationInitial === 'object'
          ? foundationInitial
          : typeof initialRelations.getState === 'function' ? initialRelations.getState() : null;
        if (beforeResume) finalResult = { ...finalResult, initialRelations: beforeResume };
        if (['applying', 'generating'].includes(beforeResume?.status) && current()) publish(finalResult);
        const initialRelationState = await initialRelations.resume();
        if (!current() || initialRelationState?.status === 'stale') return invalidResult(mine) || { status: 'stale' };
        const persisted = typeof initialRelations.getState === 'function' ? initialRelations.getState() : null;
        finalResult = { ...finalResult, initialRelations: { ...(persisted || {}), ...initialRelationState } };
      }
      if (!current()) return invalidResult(mine) || { status: 'stale' };
      publish(finalResult); return finalResult;
    })().finally(() => { if (activeFlight === flight) activeFlight = null; });
    activeFlight = flight;
    return flight.promise;
  };
  return { run, invalidate, getEpoch: () => epoch };
}
