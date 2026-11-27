// This projection controls the two people pickers only; runtime candidates remain complete.
export function isTemporarySingleAppearance(person) {
  return person.nameKind === 'temporary' && person.appearanceCount === 1
    && (person.evidenceFloorCount ?? person.appearanceCount) === 1
    && !person.selected && !person.mainCharacter && !['char', 'user'].includes(person.specialRole)
    && !person.profiled && !(person.aliases?.length);
}
export function peoplePickerProjection(people, { query = '', showTemporary = false } = {}) {
  const key = query.normalize('NFKC').trim().toLocaleLowerCase();
  const collapsedCount = people.filter(isTemporarySingleAppearance).length;
  const visible = people.filter(person => key
    ? [person.displayName, person.entityDisplayName, ...(person.aliases ?? [])].filter(Boolean).join(' ').normalize('NFKC').toLocaleLowerCase().includes(key)
    : showTemporary || !isTemporarySingleAppearance(person));
  return { visible, collapsedCount };
}
