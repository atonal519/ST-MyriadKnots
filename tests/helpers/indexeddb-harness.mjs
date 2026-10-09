export function indexedDbHarness(data) {
  let failPut = null;
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const schedule = callback => queueMicrotask(callback);
  const request = (transaction, action) => {
    const result = { result: undefined, error: null, onsuccess: null, onerror: null };
    transaction.pending += 1;
    schedule(() => {
      if (transaction.aborted) return;
      try { result.result = action(); result.onsuccess?.({ target: result }); }
      catch (error) { result.error = error; transaction.error = error; result.onerror?.({ target: result }); transaction.abort(); }
      finally {
        transaction.pending -= 1;
        schedule(() => transaction.finishIfIdle());
      }
    });
    return result;
  };
  const database = {
    objectStoreNames: { contains: name => name === 'core_records' },
    close() {},
    transaction(_storeName, mode) {
      const tx = { mode, pending: 0, aborted: false, completed: false, oncomplete: null, onerror: null, onabort: null,
        snapshot: new Map(),
        remember(key) { if (!this.snapshot.has(key)) this.snapshot.set(key, data.has(key) ? clone(data.get(key)) : undefined); },
        abort() {
          if (this.completed || this.aborted) return;
          this.aborted = true;
          for (const [key, value] of this.snapshot) value === undefined ? data.delete(key) : data.set(key, clone(value));
          schedule(() => this.onabort?.({ target: this }));
        },
        finishIfIdle() {
          if (this.pending || this.completed || this.aborted) return;
          this.completed = true;
          schedule(() => { if (this.pending) { this.completed = false; this.finishIfIdle(); } else this.oncomplete?.({ target: this }); });
        },
      };
      tx.objectStore = () => ({
        get(key) { return request(tx, () => clone(data.get(key))); },
        put(value, key) { return request(tx, () => { if (failPut && key.startsWith(failPut.prefix)) { const error = failPut.error; failPut = null; throw error; } tx.remember(key); data.set(key, clone(value)); return key; }); },
        delete(key) { return request(tx, () => { tx.remember(key); return data.delete(key); }); },
        openCursor(range) {
          let keys = null;
          const cursorRequest = { result: null, error: null, onsuccess: null, onerror: null };
          tx.pending += 1;
          let index = 0;
          const dispatch = () => schedule(() => {
            if (tx.aborted) return;
            keys ??= [...data.keys()].filter(key => !range || (key >= range.lower && key <= range.upper)).sort();
            const key = keys[index];
            if (key === undefined) { cursorRequest.result = null; cursorRequest.onsuccess?.({ target: cursorRequest }); tx.pending -= 1; schedule(() => tx.finishIfIdle()); return; }
            cursorRequest.result = { key, primaryKey: key, value: clone(data.get(key)),
              continue() { index += 1; dispatch(); }, update(value) { tx.remember(key); data.set(key, clone(value)); }, delete() { tx.remember(key); data.delete(key); } };
            cursorRequest.onsuccess?.({ target: cursorRequest });
          });
          dispatch(); return cursorRequest;
        },
        openKeyCursor(range) {
          let keys = null;
          const cursorRequest = { result: null, error: null, onsuccess: null, onerror: null };
          tx.pending += 1;
          let index = 0;
          const dispatch = () => schedule(() => {
            if (tx.aborted) return;
            keys ??= [...data.keys()].filter(key => !range || (key >= range.lower && key <= range.upper)).sort();
            const key = keys[index];
            if (key === undefined) { cursorRequest.result = null; cursorRequest.onsuccess?.({ target: cursorRequest }); tx.pending -= 1; schedule(() => tx.finishIfIdle()); return; }
            cursorRequest.result = { key, primaryKey: key, continue() { index += 1; dispatch(); }, delete() { tx.remember(key); data.delete(key); } };
            cursorRequest.onsuccess?.({ target: cursorRequest });
          });
          dispatch(); return cursorRequest;
        },
      });
      schedule(() => tx.finishIfIdle());
      return tx;
    },
  };
  return {
    indexedDB: { open() {
      const result = { result: null, error: null, onsuccess: null, onerror: null, onblocked: null };
      schedule(() => { result.result = database; result.onsuccess?.({ target: result }); });
      return result;
    } },
    keyRange: { bound: (lower, upper) => ({ lower, upper }) },
    failNextPut: (error, prefix = '') => { failPut = { error, prefix }; },
  };
}

export function localForageHarness({ hangReady = false } = {}) {
  const data = new Map(), configs = [], writes = [], native = indexedDbHarness(data);
  const localForage = {
    INDEXEDDB: 'INDEXEDDB',
    createInstance(config) {
      configs.push(config);
      return {
        async ready() { if (hangReady) return new Promise(() => {}); },
        async getItem(key) { return data.get(key) ?? null; },
        async setItem(key, value) { writes.push(key); data.set(key, structuredClone(value)); return value; },
        async removeItem(key) { data.delete(key); },
        async keys() { return [...data.keys()]; },
      };
    },
  };
  return { localForage, data, records: data, writes, configs, ...native };
}
