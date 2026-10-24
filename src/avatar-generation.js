export const DEFAULT_AVATAR_PROMPT = 'solo, portrait, headshot, looking at viewer, centered composition, simple background';

// 库项快照随本次操作使用，不建立人物映射或图库。
export function createAvatarGenerator({ apiProvider = () => globalThis.STBaiBaiImage } = {}) {
  const readApi = () => {
    const api = apiProvider();
    if (api?.apiVersion !== 1 || !['getCharacters', 'getBackendStatus', 'generate'].every(key => typeof api[key] === 'function')) throw new Error('请安装并开启柏宝绘，再生成头像。');
    const status = api.getBackendStatus();
    if (!status?.configured) throw new Error('请先在柏宝绘中完成生图设置。');
    return { api, status };
  };
  return Object.freeze({
    prepare(person) {
      const { api } = readApi();
      const characters = (api.getCharacters()?.characters ?? []).filter(item => typeof item.name === 'string' && item.name.trim() && typeof item.tag === 'string' && item.tag.trim())
        .map(({ name, tag, nl, scope }) => Object.freeze({ name, tag, nl: typeof nl === 'string' ? nl : '', ...(scope ? { scope } : {}) }));
      if (!characters.length) throw new Error('柏宝绘还没有可用角色，请先在柏宝绘补充人物外貌。');
      const names = new Set([person.displayName, person.entityDisplayName, ...(person.aliases ?? [])].filter(Boolean));
      const matching = characters.flatMap((character, index) => names.has(character.name) ? [index] : []);
      return Object.freeze({ characters: Object.freeze(characters), selectedIndex: matching.length === 1 ? matching[0] : null });
    },
    async generate({ character, prompt, clothingStyle, signal } = {}) {
      const { api, status } = readApi();
      if (!character?.name || typeof character.tag !== 'string' || !character.tag.trim()) throw new Error('请选择有外貌资料的柏宝绘角色。');
      const base = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : DEFAULT_AVATAR_PROMPT;
      const clothing = typeof clothingStyle === 'string' && clothingStyle.trim() ? `Clothing reference: ${clothingStyle.trim()}` : '';
      const characters = [{ name: character.name, tag: character.tag, nl: [character.nl || '', clothing].filter(Boolean).join('. ') }];
      // 与两三事一致：不支持独立角色通道的渠道从整体提示读取同一份角色外貌。
      const separate = status.supportsCharacters === true;
      const result = await api.generate({ prompt: [base, ...(separate ? [] : [character.tag, clothing])].filter(Boolean).join(', '),
        nl: [base, ...(separate ? [] : [character.nl || character.tag, clothing])].filter(Boolean).join('. '), characters, size: 'portrait', save: false }, { signal });
      if (typeof result?.dataUrl !== 'string' || !result.dataUrl.startsWith('data:image/')) throw new Error('柏宝绘没有返回可用图片，请检查生图结果。');
      return { dataUrl: result.dataUrl };
    },
  });
}
