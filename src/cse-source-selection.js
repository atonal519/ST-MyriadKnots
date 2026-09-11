import { sha256 } from './identity.js';
import { sanitizeMemoryContent } from './memory-content-sanitizer.js';
import { scanWorldInfo } from './world-info-scanner.js';
import { selectAssistantMessage } from './v3/foundation-domain.js';

export const CSE_SECONDARY_LOGIC = Object.freeze({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });

const clean = (value, maximum = 40000) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const normalized = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
const currentCharacter = ctx => Array.isArray(ctx?.characters) ? ctx.characters[ctx.characterId] : ctx?.characters?.[ctx.characterId];
const characterField = (character, name) => clean(character?.data?.[name] ?? character?.[name]);
const safeCall = (callback, fallback = null) => { try { return callback() ?? fallback; } catch { return fallback; } };

function macroValues({ userName, characterName }) {
  return Object.freeze({ user: clean(userName, 500), char: clean(characterName, 500) });
}

export function replaceCseSourceMacros(value, values) {
  return String(value ?? '').replace(/\{\{\s*(user|char)\s*\}\}/giu, (match, name) => values?.[normalized(name)] || match);
}

function regexFromKey(value) {
  const match = /^\/([\s\S]*)\/([dgimsuvy]*)$/u.exec(value);
  if (!match) return null;
  try { return new RegExp(match[1], match[2]); } catch { return null; }
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function cseWorldInfoKeyMatches(haystack, rawNeedle, { caseSensitive = false, matchWholeWords = false, macros = {} } = {}) {
  const needle = replaceCseSourceMacros(rawNeedle, macros).trim();
  if (!needle) return false;
  const regex = regexFromKey(needle);
  if (regex) { regex.lastIndex = 0; return regex.test(haystack); }
  const source = caseSensitive ? haystack : haystack.toLocaleLowerCase();
  const expected = caseSensitive ? needle : needle.toLocaleLowerCase();
  if (!matchWholeWords) return source.includes(expected);
  if (/\s/u.test(expected)) return source.includes(expected);
  return new RegExp(`(?:^|\\W)(${escapeRegex(expected)})(?:$|\\W)`).test(source);
}

function selectionForEntry(entry, scanText, defaults, macros) {
  if (entry.hostEnabled === false || entry.disabled === true) return Object.freeze({ selected: false, reason: 'disabled' });
  if (entry.constant === true) return Object.freeze({ selected: true, reason: 'constant' });
  const options = {
    caseSensitive: typeof entry.caseSensitive === 'boolean' ? entry.caseSensitive : defaults.caseSensitive === true,
    matchWholeWords: typeof entry.matchWholeWords === 'boolean' ? entry.matchWholeWords : defaults.matchWholeWords === true,
    macros,
  };
  const matchedPrimary = entry.primaryKeys?.find(key => cseWorldInfoKeyMatches(scanText, key, options));
  if (!matchedPrimary) return Object.freeze({ selected: false, reason: 'primary_miss' });
  const secondary = Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys : [];
  if (entry.selective !== true || secondary.length === 0) return Object.freeze({ selected: true, reason: 'primary' });
  const matches = secondary.map(key => cseWorldInfoKeyMatches(scanText, key, options));
  const logic = Object.values(CSE_SECONDARY_LOGIC).includes(entry.selectiveLogic) ? entry.selectiveLogic : CSE_SECONDARY_LOGIC.AND_ANY;
  const selected = logic === CSE_SECONDARY_LOGIC.AND_ANY ? matches.some(Boolean)
    : logic === CSE_SECONDARY_LOGIC.NOT_ALL ? !matches.every(Boolean)
      : logic === CSE_SECONDARY_LOGIC.NOT_ANY ? !matches.some(Boolean)
        : matches.every(Boolean);
  const reason = selected ? `secondary_${Object.keys(CSE_SECONDARY_LOGIC).find(name => CSE_SECONDARY_LOGIC[name] === logic).toLocaleLowerCase()}` : 'secondary_miss';
  return Object.freeze({ selected, reason });
}

export function selectCseWorldInfoEntries({ entries = [], scanText = '', defaults = {}, macros = {} } = {}) {
  return Object.freeze(entries.map(entry => Object.freeze({ entry, decision: selectionForEntry(entry, scanText, defaults, macros) })));
}

function selectedUserText(message) {
  if (!message || message.is_user !== true || (message.is_system === true && message.extra?.type)) return '';
  if (!Array.isArray(message.swipes)) return typeof message.mes === 'string' ? message.mes : '';
  const index = Number.isSafeInteger(message.swipe_id) ? message.swipe_id : 0;
  return typeof message.swipes[index] === 'string' ? message.swipes[index] : '';
}

async function targetWindow(snapshot, floor, sanitizerOptions, sourceSnapshot = null) {
  const targetIndex = floor?.hostLocator?.messageIndex;
  if (!Number.isSafeInteger(targetIndex)) return null;
  const target = selectAssistantMessage(snapshot.chat?.[targetIndex]);
  if (!target) return null;
  const liveTargetFingerprint = `sha256:${await sha256(target.rawContent)}`;
  if (!sourceSnapshot && liveTargetFingerprint !== floor.content.rawFingerprint) return null;
  const rows = [];
  let assistantCount = 0;
  for (let index = targetIndex; index >= 0 && assistantCount < 2; index -= 1) {
    const selected = selectAssistantMessage(snapshot.chat?.[index]);
    if (!selected) continue;
    rows.push({ messageIndex: index, role: 'assistant', raw: index === targetIndex && sourceSnapshot ? sourceSnapshot.canonicalContent : selected.rawContent,
      rawFingerprint: index === targetIndex && sourceSnapshot ? sourceSnapshot.rawFingerprint : null });
    const userRaw = selectedUserText(snapshot.chat?.[index - 1]);
    if (userRaw) rows.push({ messageIndex: index - 1, role: 'user', raw: userRaw });
    assistantCount += 1;
  }
  rows.reverse();
  const frozenRows = [];
  for (const row of rows) frozenRows.push(Object.freeze({
    messageIndex: row.messageIndex,
    role: row.role,
    content: sanitizeMemoryContent(row.raw, sanitizerOptions),
    rawFingerprint: row.rawFingerprint ?? `sha256:${await sha256(row.raw)}`,
  }));
  const signature = `sha256:${await sha256(JSON.stringify([liveTargetFingerprint, frozenRows.map(row => [row.messageIndex, row.role, row.rawFingerprint])]))}`;
  return Object.freeze({ rows: Object.freeze(frozenRows), signature, scanText: frozenRows.map(row => row.content).filter(Boolean).join('\n\n') });
}

export function captureCseAuthorNote(ctx) {
  const character = currentCharacter(ctx) ?? {};
  const metadata = ctx?.chatMetadata && typeof ctx.chatMetadata === 'object' ? ctx.chatMetadata : {};
  const noteSettings = ctx?.extensionSettings?.note && typeof ctx.extensionSettings.note === 'object' ? ctx.extensionSettings.note : {};
  const hasChatPrompt = Object.hasOwn(metadata, 'note_prompt');
  const chatPrompt = clean(hasChatPrompt ? metadata.note_prompt : noteSettings.default);
  const filename = clean(safeCall(() => ctx?.getCharaFilename?.(ctx.characterId), ''), 500)
    || clean(character?.avatar ?? character?.data?.avatar, 500).replace(/\.[^.]+$/u, '');
  const names = new Set([filename, clean(character?.avatar, 500), clean(character?.name ?? character?.data?.name, 500)].filter(Boolean));
  const characterNote = Array.isArray(noteSettings.chara) ? noteSettings.chara.find(note => names.has(clean(note?.name, 500))) : null;
  const useCharacter = characterNote?.useChara === true;
  const characterPrompt = useCharacter ? clean(characterNote?.prompt) : '';
  const mode = useCharacter && [0, 1, 2].includes(Number(characterNote?.position)) ? Number(characterNote.position) : null;
  const content = !useCharacter ? chatPrompt : mode === 1 ? [characterPrompt, chatPrompt].filter(Boolean).join('\n')
    : mode === 2 ? [chatPrompt, characterPrompt].filter(Boolean).join('\n') : characterPrompt;
  return Object.freeze({ content, chatPrompt, characterPrompt, characterMode: mode, usedDefault: !hasChatPrompt, intervalIgnored: true });
}

function staleError() {
  const error = new Error('读取来源期间聊天身份或目标楼前缀已变化，本次 CSE 未发送。');
  error.code = 'V3_CSE_STALE';
  return error;
}

export async function captureCseRequestSources({ hostAdapter, baseline, floor, expectedChatId, filterWorldInfoSources = sources => sources, sanitizerOptions = {}, sourceSnapshot = null } = {}) {
  const before = hostAdapter.snapshot();
  const beforeChatId = clean(before.context?.chatMetadata?.qianqianjie?.chatId, 200);
  if (beforeChatId !== expectedChatId) throw staleError();
  const window = await targetWindow(before, floor, sanitizerOptions, sourceSnapshot);
  if (!window) throw staleError();
  const ctx = before.context;
  const character = currentCharacter(ctx) ?? {};
  const latest = Object.freeze({
    userPersona: Object.freeze({ ...baseline.userPersona, description: clean(ctx?.powerUserSettings?.persona_description ?? ctx?.personaDescription ?? ctx?.persona?.description) }),
    characterCard: Object.freeze({
      ...baseline.characterCard,
      description: characterField(character, 'description'), personality: characterField(character, 'personality'), scenario: characterField(character, 'scenario'),
    }),
    authorNote: captureCseAuthorNote(ctx),
  });
  const bindings = typeof hostAdapter.getWorldInfoBindings === 'function' ? hostAdapter.getWorldInfoBindings() : {};
  const filterBookNames = names => {
    const filtered = filterWorldInfoSources(names.map(sourceName => Object.freeze({ sourceName })));
    if (!Array.isArray(filtered)) {
      const error = new Error('世界书排除结果无效。'); error.code = 'V3_CSE_WORLDBOOK_FILTER_INVALID'; throw error;
    }
    const allowed = new Set(filtered.map(source => typeof source?.sourceName === 'string' ? source.sourceName.trim() : '').filter(Boolean));
    return names.filter(name => allowed.has(name));
  };
  const catalog = await scanWorldInfo(ctx, { bindings, strict: true, includeCatalog: false, filterBookNames });
  const macros = macroValues({ userName: latest.userPersona.name, characterName: latest.characterCard.name });
  const decisions = selectCseWorldInfoEntries({ entries: catalog.entries, scanText: window.scanText, defaults: catalog.defaults, macros });
  const prepared = [];
  const reasonCounts = {};
  for (const { entry, decision } of decisions) {
    reasonCounts[decision.reason] = (reasonCounts[decision.reason] ?? 0) + 1;
    if (!decision.selected) continue;
    const content = clean(replaceCseSourceMacros(entry.content, macros));
    if (!content) continue;
    prepared.push(Object.freeze({
      sourceKind: 'worldbook', sourceName: entry.source, scope: entry.scope || 'unknown', locator: `${entry.source}:${entry.uid}`,
      enabled: true, activated: true, triggerReason: decision.reason, content,
      fingerprint: `sha256:${await sha256(content)}`, visibility: 'authorial',
    }));
  }
  const filtered = filterWorldInfoSources(prepared);
  if (!Array.isArray(filtered)) {
    const error = new Error('世界书排除结果无效。'); error.code = 'V3_CSE_WORLDBOOK_FILTER_INVALID'; throw error;
  }
  const after = hostAdapter.snapshot();
  const afterChatId = clean(after.context?.chatMetadata?.qianqianjie?.chatId, 200);
  const afterWindow = await targetWindow(after, floor, sanitizerOptions, sourceSnapshot);
  if (afterChatId !== expectedChatId || !afterWindow || afterWindow.signature !== window.signature) throw staleError();
  const fingerprintPayload = {
    userPersona: latest.userPersona, characterCard: latest.characterCard, authorNote: latest.authorNote,
    worldInfoSources: filtered.map(source => ({ locator: source.locator, fingerprint: source.fingerprint, triggerReason: source.triggerReason })),
    targetWindowSignature: window.signature,
  };
  const fingerprint = `sha256:${await sha256(JSON.stringify(fingerprintPayload))}`;
  const diagnostics = Object.freeze({
    catalogEntries: catalog.entries.length, enabledEntries: catalog.entries.filter(entry => entry.hostEnabled !== false).length,
    selectedEntries: filtered.length, excludedSelectedEntries: prepared.length - filtered.length,
    worldInfoCharacters: filtered.reduce((sum, source) => sum + source.content.length, 0),
    personaCharacters: latest.userPersona.description.length, characterCardCharacters: ['description', 'personality', 'scenario'].reduce((sum, key) => sum + latest.characterCard[key].length, 0),
    authorNoteCharacters: latest.authorNote.content.length, scanCharacters: window.scanText.length,
    triggerReasons: Object.freeze({ ...reasonCounts }), sourceFingerprint: fingerprint,
  });
  return Object.freeze({ ...latest, worldInfoSources: Object.freeze([...filtered]), targetWindow: window, fingerprint, diagnostics });
}
