const TAG_NAME_PATTERN = /^[\p{L}][\p{L}\p{N}_-]*~?$/u;

export function normalizeMemoryTagList(value) {
  return String(value || '').split(',').map(item => String(item).trim().toLowerCase())
    .filter(item => TAG_NAME_PATTERN.test(item) && !/~~|~.+/.test(item));
}

const escapeTagName = name => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function sanitizeMemoryContent(raw, options = {}) {
  if (!raw) return '';
  const keep = normalizeMemoryTagList(options.keepTags ?? 'content');
  const extra = normalizeMemoryTagList(options.extraTags ?? '');
  let content = String(raw);
  content = content.replace(/<!--[\s\S]*?-->/g, '');

  const keepStash = [];
  for (const name of keep) {
    const safeName = escapeTagName(name);
    const pattern = new RegExp(`<${safeName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safeName}\\s*>`, 'gi');
    content = content.replace(pattern, (_match, inner) => {
      keepStash.push(inner);
      return ` KEEP${keepStash.length - 1} `;
    });
  }

  for (const name of extra) {
    const safeName = escapeTagName(name);
    const pattern = new RegExp(`<${safeName}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${safeName}\\s*>`, 'gi');
    let previous;
    do { previous = content; content = content.replace(pattern, ''); } while (content !== previous);
  }

  let previous;
  do {
    previous = content;
    content = content.replace(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g, '');
  } while (content !== previous);
  content = content.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g, '');
  content = content.replace(/ KEEP(\d+) /g, (_match, index) => keepStash[+index] ?? '');

  do {
    previous = content;
    content = content.replace(/<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/g, '');
  } while (content !== previous);
  content = content.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?\/?>/g, '');
  return content.replace(/\n{3,}/g, '\n\n').trim();
}
