const normalizeText = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';

export function createBaiBaiBookMemoryAdapter({ globalProvider = () => globalThis } = {}) {
  return {
    readRelativeText() {
      try {
        const api = globalProvider()?.STBaiBaiBook;
        return normalizeText(api?.getInjectedHistory?.()?.relativeText);
      } catch {
        return '';
      }
    },
  };
}
