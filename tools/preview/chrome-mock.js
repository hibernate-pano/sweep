/**
 * 仅用于本地预览：给 popup / options 页面提供一份 chrome.* 的假实现。
 * 预览服务器会自动把这个文件注入到 HTML 里，正式构建不会用到。
 */
(() => {
  const DEFAULTS = {
    settings: {
      theme: 'dark',
      scope: 'current',
      items: { cache: true, siteData: true, cookies: false, history: true },
      since: 'all',
      customOrigins: ['https://news.ycombinator.com'],
      keepLogin: ['mail.google.com'],
      auto: { onStartup: false, onExit: false, daily: false, dailyTime: '23:30' },
    },
    cleanHistory: [
      { ts: Date.now() - 3600_000, scope: 'current', freed: 4_812_000, historyRemoved: 12 },
      { ts: Date.now() - 86_400_000, scope: 'all', freed: null, historyRemoved: 1843 },
    ],
  };

  const SS_KEY = '__preview_storage__';
  // 跨页面刷新保留状态，否则每次刷新都回到初始值，没法验证连续操作。
  let storage;
  try {
    storage = JSON.parse(sessionStorage.getItem(SS_KEY) || 'null');
  } catch {
    storage = null;
  }
  if (!storage) storage = JSON.parse(JSON.stringify(DEFAULTS));
  const persist = () => {
    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify(storage));
    } catch {}
  };

  const clone = (v) => JSON.parse(JSON.stringify(v));

  let usage = 4_812_000;
  let cloudTotal = 34;

  const probe = () => ({
    usage,
    quota: 306_000_000,
    localStorageKeys: usage > 0 ? 18 : 0,
    indexedDB: usage > 0 ? ['conversation-store', 'apexlog'] : [],
    caches: usage > 0 ? ['v1-images', 'api-cache'] : [],
    hasServiceWorker: usage > 0,
  });

  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '1.0.0', name: 'Clear Browsing Data' }),
      openOptionsPage: () => {},
      onMessage: { addListener: () => {} },
      lastError: null,
      getURL: (p) => p,
    },
    storage: {
      local: {
        get: async (key) => {
          if (key === undefined) return clone(storage);
          if (typeof key === 'string') return key in storage ? { [key]: clone(storage[key]) } : {};
          const out = {};
          for (const k of Object.keys(key)) {
            if (k in storage) out[k] = clone(storage[k]);
          }
          return out;
        },
        set: async (obj) => {
          Object.assign(storage, clone(obj));
          persist();
        },
        remove: async (key) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete storage[k];
          persist();
        },
      },
      onChanged: { addListener: () => {} },
    },
    tabs: {
      query: async () => [
        {
          id: 1,
          url: new URLSearchParams(location.search).get('tab') || 'https://chatgpt.com/c/8f2a-91',
          active: true,
          title: 'ChatGPT',
        },
      ],
      reload: () => {},
      create: () => {},
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        const src = String(func);
        if (src.includes('indexedDB.databases')) return [{ result: clone(probe()) }];
        if (src.includes('backend-api/conversations')) {
          if (args && args[0] === 'delete') {
            const n = cloudTotal;
            cloudTotal = 0;
            deletedOnce = true;
            return [{ result: { ok: true, total: n, deleted: n, error: null } }];
          }
          return [{ result: { ok: true, total: cloudTotal, deleted: 0, error: null } }];
        }
        if (src.includes('chat_conversations')) {
          return [{ result: { ok: false, total: 0, deleted: 0, error: 'list:404' } }];
        }
        return [{ result: null }];
      },
    },
    cookies: {
      getAll: async () => new Array(12).fill({ name: 'x' }),
    },
    browsingData: {
      remove: async () => {
        await new Promise((r) => setTimeout(r, 120));
        usage = 0;
      },
    },
    history: {
      search: async () => new Array(37).fill({ url: 'https://chatgpt.com/c/x', title: 'ChatGPT' }),
      deleteUrl: async () => {},
      deleteRange: async () => {},
    },
    commands: {
      getAll: async () => [{ name: '_execute_action', shortcut: 'Ctrl+Shift+K' }],
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    alarms: { create: () => {}, clear: async () => {} },
    windows: { getAll: async () => [] },
  };
})();
