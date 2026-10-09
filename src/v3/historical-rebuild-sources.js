const copy = value => { try { return structuredClone(value); } catch { return null; } };
const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : typeof value === 'string' && value.trim() ? [value] : [];

export function captureHistoricalRebuildSources(snapshot, {
  worldInfoBindings = {},
  getCharacterLorebooks = () => null,
  getGlobalSelection = () => null,
  loadWorldInfo = async () => null,
} = {}) {
  const rawContext = snapshot?.context;
  if (!rawContext || typeof rawContext !== 'object') throw new TypeError('历史重构作者来源不可用');
  const read = (provider, fallback = null) => { try { return copy(provider?.()) ?? fallback; } catch { return fallback; } };
  let helperCharacters = null, helperGlobals = null;
  try { helperCharacters = copy(getCharacterLorebooks()); } catch { /* selected character books can be absent */ }
  try { helperGlobals = copy(getGlobalSelection()); } catch { /* global selection can be absent */ }
  const rawCharacter = Array.isArray(rawContext.characters) ? rawContext.characters[rawContext.characterId] : rawContext.characters?.[rawContext.characterId];
  const data = rawCharacter?.data ?? {};
  const character = {
    name: rawCharacter?.name ?? data.name, avatar: rawCharacter?.avatar ?? data.avatar,
    description: rawCharacter?.description ?? data.description, personality: rawCharacter?.personality ?? data.personality,
    scenario: rawCharacter?.scenario ?? data.scenario,
    extensions: { world: rawCharacter?.extensions?.world },
    data: { name: data.name, avatar: data.avatar, description: data.description, personality: data.personality, scenario: data.scenario,
      extensions: { world: data.extensions?.world },
      character_book: data.character_book ? { name: data.character_book.name, entries: copy(data.character_book.entries) ?? [] } : undefined },
  };
  const auxWorlds = (() => { try { return copy(rawContext.getCharaAuxWorlds?.(String(character.avatar ?? '').replace(/\.[^.]+$/u, ''))); } catch { return null; } })() ?? [];
  const chatWorldInfoNames = (() => { try { return copy(rawContext.chatWorldInfo?.getNames?.()); } catch { return null; } })() ?? [];
  const chatWorldInfoGlobalSelection = (() => { try { return copy(rawContext.chatWorldInfo?.globalSelection); } catch { return null; } })() ?? [];
  const selected = read(worldInfoBindings.getSelectedWorldInfo, []);
  const settings = read(worldInfoBindings.getWorldInfoSettings, {});
  const names = [...new Set([
    ...list(selected), ...list(read(worldInfoBindings.getWorldInfoNames, [])), ...list(helperGlobals),
    ...list(helperCharacters?.primary), ...list(helperCharacters?.additional),
    ...list(rawContext.chatMetadata?.world_info), ...list(chatWorldInfoNames), ...list(chatWorldInfoGlobalSelection),
    ...list(auxWorlds), ...list(data.extensions?.world), ...list(rawCharacter?.extensions?.world),
    ...list(rawContext.powerUserSettings?.persona_description_lorebook),
  ])];
  const worldInfo = Object.freeze({
    selected, settings, names,
    caseSensitive: worldInfoBindings.getDefaultCaseSensitive?.() === true,
    matchWholeWords: worldInfoBindings.getDefaultMatchWholeWords?.() === true,
    characterLorebooks: helperCharacters ?? {},
    globalSelection: list(helperGlobals),
    loadWorldInfo: name => loadWorldInfo(name),
  });
  const context = Object.freeze({
    name1: String(rawContext.name1 ?? ''), name2: String(rawContext.name2 ?? character.name ?? ''), characterId: 0, characters: [character],
    personaId: String(rawContext.personaId ?? ''), userAvatar: String(rawContext.userAvatar ?? snapshot.userIdentity?.personaIdentifier ?? ''),
    personaDescription: String(rawContext.personaDescription ?? rawContext.powerUserSettings?.persona_description ?? ''),
    powerUserSettings: { persona_description: rawContext.powerUserSettings?.persona_description,
      persona_description_lorebook: rawContext.powerUserSettings?.persona_description_lorebook },
    extensionSettings: { note: copy(rawContext.extensionSettings?.note) ?? {} },
    characterAuxWorlds: auxWorlds, chatWorldInfoNames, chatWorldInfoGlobalSelection,
  });
  return Object.freeze({ context, userIdentity: copy(snapshot.userIdentity), worldInfo });
}
