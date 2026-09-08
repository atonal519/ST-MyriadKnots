const BARE_KEY_START = /[A-Za-z_]/u;
const BARE_KEY_PART = /[A-Za-z0-9_-]/u;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
const MAX_REPAIRS = 64;

function normalizeFinishReason(value) {
  return String(value ?? '').trim().toLowerCase();
}

function scanner(source, { trailingCommasOnly = false, requireOperations = true } = {}) {
  let index = 0;
  let output = '';
  const operations = [];
  let duplicateKey = false;

  const addOperation = (type, at, value = '') => {
    if (trailingCommasOnly && type !== 'remove-trailing-comma') throw new SyntaxError('non-trailing-json-repair');
    if (operations.length >= MAX_REPAIRS) throw new SyntaxError('too-many-json-symbol-repairs');
    operations.push(Object.freeze({ type, index: at, value }));
  };
  const whitespace = () => {
    const start = index;
    while (/\s/u.test(source[index] ?? '')) index += 1;
    output += source.slice(start, index);
    return index - start;
  };
  const valueStart = char => char === '{' || char === '[' || char === '"' || char === '-' || /[0-9]/u.test(char ?? '') || char === 't' || char === 'f' || char === 'n';

  const stringToken = ({ value = false } = {}) => {
    if (source[index] !== '"') return null;
    let raw = '"';
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === '"') {
        if (value) {
          let boundary = index + 1;
          while (/\s/u.test(source[boundary] ?? '')) boundary += 1;
          const separatedNextToken = boundary > index + 1 && (valueStart(source[boundary]) || BARE_KEY_START.test(source[boundary] ?? ''));
          const closesValue = boundary === source.length || [',', '}', ']'].includes(source[boundary]) || separatedNextToken;
          if (!closesValue) {
            let paired = index + 1;
            while (paired < source.length) {
              if (source[paired] === '\\') { paired += 2; continue; }
              if (source[paired] === '"') break;
              paired += 1;
            }
            if (paired >= source.length || paired === index + 1) return null;
            let afterPair = paired + 1;
            while (/\s/u.test(source[afterPair] ?? '')) afterPair += 1;
            if (source[afterPair] === ':') return null;
            addOperation('escape-string-quote', index, '\\');
            raw += '\\"';
            index += 1;
            continue;
          }
        }
        raw += '"';
        index += 1;
        let decoded;
        try { decoded = JSON.parse(raw); } catch { return null; }
        output += raw;
        return { kind: 'string', decoded };
      }
      if (char === '\\') {
        const escapeStart = index;
        index += 1;
        const escape = source[index];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(index + 1, index + 5))) return null;
          index += 5;
          raw += source.slice(escapeStart, index);
          continue;
        }
        if (!/["\\/bfnrt]/u.test(escape ?? '')) return null;
        index += 1;
        raw += source.slice(escapeStart, index);
        continue;
      }
      if (char.charCodeAt(0) <= 0x1f) return null;
      raw += char;
      index += 1;
    }
    return null;
  };

  const bareKeyToken = () => {
    if (!BARE_KEY_START.test(source[index] ?? '')) return null;
    const start = index;
    index += 1;
    while (BARE_KEY_PART.test(source[index] ?? '')) index += 1;
    const raw = source.slice(start, index);
    if (source[index] === '"') {
      addOperation('insert-key-opening-quote', start, '"');
      output += `"${raw}`;
      const closingAt = index;
      index += 1;
      output += '"';
      return { key: raw, repaired: true, end: index, closingAt };
    }
    addOperation('quote-bare-key', start, '""');
    output += `"${raw}"`;
    return { key: raw, repaired: true, end: index };
  };

  const inspectKey = at => {
    let cursor = at;
    if (source[cursor] === '"') {
      cursor += 1;
      let decoded = '';
      while (cursor < source.length) {
        const char = source[cursor];
        if (char === '\\') {
          const escape = source[cursor + 1];
          if (escape === 'u') {
            if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(cursor + 2, cursor + 6))) return null;
            cursor += 6;
          } else if (/["\\/bfnrt]/u.test(escape ?? '')) cursor += 2;
          else return null;
          continue;
        }
        if (char === '"') {
          const raw = source.slice(at, cursor + 1);
          try { decoded = JSON.parse(raw); } catch { return null; }
          cursor += 1;
          break;
        }
        if (char.charCodeAt(0) <= 0x1f) return null;
        cursor += 1;
      }
      if (!decoded && source[cursor - 1] !== '"') return null;
      while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
      return { kind: 'quoted', key: decoded, colon: source[cursor] === ':', valueAt: cursor };
    }
    if (!BARE_KEY_START.test(source[cursor] ?? '')) return null;
    const start = cursor;
    cursor += 1;
    while (BARE_KEY_PART.test(source[cursor] ?? '')) cursor += 1;
    const key = source.slice(start, cursor);
    if (source[cursor] === '"') cursor += 1;
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
    return { kind: 'bare', key, colon: source[cursor] === ':', valueAt: cursor };
  };

  const parseKey = () => {
    if (source[index] === '"') {
      const token = stringToken();
      return token ? { key: token.decoded, repaired: false } : null;
    }
    return bareKeyToken();
  };

  const parseValue = () => {
    const char = source[index];
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return stringToken({ value: true });
    for (const literal of ['true', 'false', 'null']) {
      if (source.startsWith(literal, index)) {
        output += literal;
        index += literal.length;
        return { kind: 'literal' };
      }
    }
    NUMBER.lastIndex = index;
    const match = NUMBER.exec(source);
    if (match) {
      output += match[0];
      index = NUMBER.lastIndex;
      return { kind: 'number' };
    }
    return null;
  };

  function parseObject() {
    const keys = new Set();
    output += '{';
    index += 1;
    whitespace();
    if (source[index] === '}') { output += '}'; index += 1; return { kind: 'object' }; }
    while (index < source.length) {
      const keyToken = parseKey();
      if (!keyToken) return null;
      if (keys.has(keyToken.key)) duplicateKey = true;
      keys.add(keyToken.key);
      const colonGap = whitespace();
      if (source[index] === ':') { output += ':'; index += 1; }
      else if (valueStart(source[index]) && (source[index] !== '"' || colonGap > 0)) { addOperation('insert-colon', index, ':'); output += ':'; }
      else return null;
      whitespace();
      const value = parseValue();
      if (!value) return null;
      const gap = whitespace();
      if (source[index] === '}') { output += '}'; index += 1; return { kind: 'object' }; }
      if (source[index] === ',') {
        const commaAt = index;
        index += 1;
        const commaGapStart = index;
        while (/\s/u.test(source[index] ?? '')) index += 1;
        if (source[index] === '}') {
          addOperation('remove-trailing-comma', commaAt);
          output += source.slice(commaGapStart, index);
          output += '}';
          index += 1;
          return { kind: 'object' };
        }
        output += `,${source.slice(commaGapStart, index)}`;
        continue;
      }
      const nextKey = inspectKey(index);
      const nextCanHaveColon = nextKey && (nextKey.colon || valueStart(source[nextKey.valueAt]));
      const safeBoundary = nextKey && nextCanHaveColon && (gap > 0 || value.kind === 'object' || value.kind === 'array');
      if (!safeBoundary) return null;
      addOperation('insert-comma', index, ',');
      output += ',';
    }
    return null;
  }

  function parseArray() {
    output += '[';
    index += 1;
    whitespace();
    if (source[index] === ']') { output += ']'; index += 1; return { kind: 'array' }; }
    while (index < source.length) {
      const value = parseValue();
      if (!value) return null;
      whitespace();
      if (source[index] === ']') { output += ']'; index += 1; return { kind: 'array' }; }
      if (source[index] === ',') {
        const commaAt = index;
        index += 1;
        const commaGapStart = index;
        while (/\s/u.test(source[index] ?? '')) index += 1;
        if (source[index] === ']') {
          addOperation('remove-trailing-comma', commaAt);
          output += source.slice(commaGapStart, index);
          output += ']';
          index += 1;
          return { kind: 'array' };
        }
        output += `,${source.slice(commaGapStart, index)}`;
        continue;
      }
      const next = source[index];
      const separatedValues = gap > 0 && valueStart(next);
      if (!separatedValues && ((value.kind !== 'object' && value.kind !== 'array') || (next !== '{' && next !== '['))) return null;
      addOperation('insert-comma', index, ',');
      output += ',';
    }
    return null;
  }

  try {
    whitespace();
    const parsedRoot = parseValue();
    if (!parsedRoot) return null;
    whitespace();
    if (index !== source.length || requireOperations && !operations.length || duplicateKey) return null;
    let value;
    try { value = JSON.parse(output); } catch { return null; }
    return Object.freeze({ value, text: output, repaired: true, operations: Object.freeze(operations) });
  } catch { return null; }
}

export function parseJsonWithSymbolRepair(value, { finishReason } = {}) {
  const text = String(value ?? '').trim();
  try {
    return Object.freeze({ value: JSON.parse(text), text, repaired: false, operations: Object.freeze([]) });
  } catch { /* only a true stop may enter the symbol-only repair */ }
  if (normalizeFinishReason(finishReason) !== 'stop') return null;
  return scanner(text);
}

export function parseJsonWithSafeTrailingCommas(value) {
  const text = String(value ?? '').trim();
  try {
    return Object.freeze({ value: JSON.parse(text), text, repaired: false, operations: Object.freeze([]) });
  } catch { /* retain the existing trailing-comma compatibility with lexical boundaries */ }
  return scanner(text, { trailingCommasOnly: true });
}

export function repairJsonWithUniqueMissingObjectClose(value, { finishReason, allowArray = false } = {}) {
  if (normalizeFinishReason(finishReason) !== 'stop') return null;
  const text = String(value ?? '').trim();
  const repairs = [];
  for (let index = Math.max(0, text.length - 64); index <= text.length; index += 1) {
    if (index < text.length && !/[}\]]/u.test(text[index])) continue;
    try {
      const candidate = `${text.slice(0, index)}}${text.slice(index)}`;
      const parsed = JSON.parse(candidate);
      const inspected = scanner(candidate, { requireOperations: false });
      if (inspected && parsed && typeof parsed === 'object' && (allowArray || !Array.isArray(parsed))) repairs.push(parsed);
    } catch { /* try the next mechanically possible suffix position */ }
  }
  return repairs.length === 1 ? repairs[0] : null;
}
