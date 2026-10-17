const sameLocator = (left, right) => left?.messageIndex === right?.messageIndex
  && left?.swipeId === right?.swipeId
  && left?.selectedSwipeIndex === right?.selectedSwipeIndex;

const contentOf = floor => floor?.content ?? {};

function addPair(index, first, second, value) {
  let secondIndex = index.get(first);
  if (!secondIndex) index.set(first, secondIndex = new Map());
  let values = secondIndex.get(second);
  if (!values) secondIndex.set(second, values = []);
  values.push(value);
}

function pairValues(index, first, second) {
  return index.get(first)?.get(second) ?? [];
}

function addLocator(index, locator, value) {
  let bySwipe = index.get(locator?.messageIndex);
  if (!bySwipe) index.set(locator?.messageIndex, bySwipe = new Map());
  let bySelectedSwipe = bySwipe.get(locator?.swipeId);
  if (!bySelectedSwipe) bySwipe.set(locator?.swipeId, bySelectedSwipe = new Map());
  let values = bySelectedSwipe.get(locator?.selectedSwipeIndex);
  if (!values) bySelectedSwipe.set(locator?.selectedSwipeIndex, values = []);
  values.push(value);
}

function locatorValues(index, locator) {
  return index.get(locator?.messageIndex)?.get(locator?.swipeId)?.get(locator?.selectedSwipeIndex) ?? [];
}

/**
 * Prove a one-to-one mapping between persisted floors and current host candidates.
 * Valid anchors are reserved first, then unanchored candidates may use the same
 * locator with the same canonical body or exact raw body, or a unique
 * raw+canonical pair among the remaining unbound floors and candidates.
 */
export function matchFloorCandidates(floors = [], candidates = []) {
  const floorList = Array.isArray(floors) ? floors : [];
  const candidateList = Array.isArray(candidates) ? candidates : [];
  const floorById = new Map(floorList.map((floor, floorIndex) => [floor?.id, { floor, floorIndex }]));
  const floorsByLocator = new Map();
  const floorsByFingerprint = new Map();
  const candidatesByFingerprint = new Map();
  floorList.forEach((floor, floorIndex) => {
    addLocator(floorsByLocator, floor?.hostLocator, { floor, floorIndex });
    addPair(floorsByFingerprint, contentOf(floor).rawFingerprint, contentOf(floor).canonicalFingerprint, { floor, floorIndex });
  });
  candidateList.forEach((candidate, candidateIndex) => {
    addPair(candidatesByFingerprint, candidate?.rawFingerprint, candidate?.canonicalFingerprint, { candidate, candidateIndex });
  });
  const floorMatches = new Map();
  const candidateMatches = new Map();
  let issue = null;

  const fail = (code, candidateIndex, floorIndex = null) => {
    if (issue) return;
    const candidate = candidateList[candidateIndex] ?? null;
    const floor = floorIndex === null ? null : floorList[floorIndex] ?? null;
    issue = Object.freeze({
      code,
      candidateIndex,
      floorIndex,
      markerStatus: candidate?.messageAnchor?.status ?? 'invalid',
      assistantSeq: floor?.assistantSeq ?? candidate?.assistantSeq ?? null,
      messageIndex: candidate?.hostLocator?.messageIndex ?? floor?.hostLocator?.messageIndex ?? null,
    });
  };
  const bind = (candidateIndex, floorIndex, kind) => {
    if (candidateMatches.has(candidateIndex) || floorMatches.has(floorIndex)) {
      fail('duplicateBinding', candidateIndex, floorIndex);
      return false;
    }
    const candidate = candidateList[candidateIndex];
    const floor = floorList[floorIndex];
    const match = Object.freeze({
      candidate,
      candidateIndex,
      floor,
      floorIndex,
      kind,
      markerStatus: candidate?.messageAnchor?.status ?? 'invalid',
      locatorMatches: sameLocator(floor?.hostLocator, candidate?.hostLocator),
      rawFingerprintMatches: contentOf(floor).rawFingerprint === candidate?.rawFingerprint,
      canonicalFingerprintMatches: contentOf(floor).canonicalFingerprint === candidate?.canonicalFingerprint,
      sanitizerFingerprintMatches: contentOf(floor).sanitizerFingerprint === candidate?.sanitizerFingerprint,
    });
    candidateMatches.set(candidateIndex, match);
    floorMatches.set(floorIndex, match);
    return true;
  };

  // Reserve every explicit marker before considering content fallback, so an
  // earlier unanchored candidate cannot consume a floor claimed later by marker.
  for (const [candidateIndex, candidate] of candidateList.entries()) {
    if (candidate?.archiveCandidate === true) {
      const target = floorById.get(candidate.archiveFloorId);
      if (!target) { fail('archiveFloorMissing', candidateIndex); continue; }
      if (floorMatches.has(target.floorIndex)) { fail('duplicateBinding', candidateIndex, target.floorIndex); continue; }
      bind(candidateIndex, target.floorIndex, 'archive');
      continue;
    }
    const marker = candidate?.messageAnchor;
    if (marker?.status === 'none') continue;
    if (marker?.status !== 'valid') { fail('markerRejected', candidateIndex); continue; }
    const target = floorById.get(marker.anchor?.floorId);
    if (!target) { fail('markerConflict', candidateIndex); continue; }
    if (floorMatches.has(target.floorIndex)) { fail('duplicateMarker', candidateIndex, target.floorIndex); continue; }
    bind(candidateIndex, target.floorIndex, 'marker');
  }

  for (const [candidateIndex, candidate] of candidateList.entries()) {
    if (candidate?.archiveCandidate === true) continue;
    if (candidateMatches.has(candidateIndex) || candidate?.messageAnchor?.status !== 'none') continue;
    const matches = locatorValues(floorsByLocator, candidate?.hostLocator)
      .filter(({ floor, floorIndex }) => !floorMatches.has(floorIndex)
        && sameLocator(floor?.hostLocator, candidate?.hostLocator)
        && (contentOf(floor).canonicalFingerprint === candidate?.canonicalFingerprint
          || contentOf(floor).rawFingerprint === candidate?.rawFingerprint));
    if (matches.length === 1) {
      const floor = matches[0].floor;
      bind(candidateIndex, matches[0].floorIndex,
        contentOf(floor).canonicalFingerprint === candidate?.canonicalFingerprint ? 'locatorCanonical' : 'locatorRaw');
    }
    else if (matches.length > 1) fail('ambiguousLocatorCanonical', candidateIndex);
  }

  for (const [candidateIndex, candidate] of candidateList.entries()) {
    if (candidate?.archiveCandidate === true) continue;
    if (candidateMatches.has(candidateIndex) || candidate?.messageAnchor?.status !== 'none') continue;
    const matches = pairValues(floorsByFingerprint, candidate?.rawFingerprint, candidate?.canonicalFingerprint)
      .filter(({ floor, floorIndex }) => !floorMatches.has(floorIndex)
        && contentOf(floor).rawFingerprint === candidate?.rawFingerprint
        && contentOf(floor).canonicalFingerprint === candidate?.canonicalFingerprint);
    const competingCandidates = matches.length ? pairValues(candidatesByFingerprint, candidate?.rawFingerprint, candidate?.canonicalFingerprint)
      .filter(({ candidate: value, candidateIndex: index }) => !candidateMatches.has(index)
        && value?.messageAnchor?.status === 'none'
        && value.rawFingerprint === candidate.rawFingerprint
        && value.canonicalFingerprint === candidate.canonicalFingerprint) : [];
    if (matches.length === 1 && competingCandidates.length === 1) bind(candidateIndex, matches[0].floorIndex, 'uniqueFingerprint');
    else if (matches.length > 0) fail('ambiguousFingerprint', candidateIndex);
  }

  return Object.freeze({
    matches: Object.freeze([...candidateMatches.values()].sort((left, right) => left.candidateIndex - right.candidateIndex)),
    candidateMatches,
    floorMatches,
    unmatchedCandidateIndexes: Object.freeze(candidateList.map((_, index) => index).filter(index => !candidateMatches.has(index))),
    unmatchedFloorIndexes: Object.freeze(floorList.map((_, index) => index).filter(index => !floorMatches.has(index))),
    issue,
  });
}
