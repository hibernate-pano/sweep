/**
 * 仅用于本地预览：给 popup / options 页面提供一份 chrome.* 的假实现。
 * 预览服务器会自动把这个文件注入到 HTML 里，正式构建不会用到。
 */
(() => {
  const DEFAULTS = {
    settings: {
      theme: 'dark',
      scope: 'all',
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

  // 假的历史：14 个站、一百多条记录，摊在最近 30 天里。
  // 这样「全部网站」的圆盘才有真实的形状可看。
  const MOCK_SITES = [
    ['github.com', '/repos', 26],
    ['news.ycombinator.com', '/item', 18],
    ['developer.mozilla.org', '/en-US/docs', 14],
    ['chatgpt.com', '/c', 12],
    ['mail.google.com', '/mail/u/0', 10],
    ['stackoverflow.com', '/questions', 9],
    ['youtube.com', '/watch', 8],
    ['zhihu.com', '/question', 7],
    ['bilibili.com', '/video', 6],
    ['twitter.com', '/home', 5],
    ['developer.chrome.com', '/docs', 5],
    ['figma.com', '/file', 4],
    ['notion.so', '/page', 4],
    ['news.ycombinator.com', '/newest', 3],
  ];

  const mockHistory = [];
  {
    let id = 0;
    for (const [host, path, n] of MOCK_SITES) {
      for (let k = 0; k < n; k += 1) {
        id += 1;
        mockHistory.push({
          id: String(id),
          url: `https://${host}${path}/${k + 1}`,
          title: `${host} 的第 ${k + 1} 页`,
          visitCount: 1 + ((id * 7) % 23),
          lastVisitTime: Date.now() - Math.round((id / 141) * 30 * 86400_000),
        });
      }
    }
    mockHistory.sort((a, b) => b.lastVisitTime - a.lastVisitTime);
  }

  // 假的 Cookie：24 条，摊在 9 个域上。
  const mockCookies = [];
  {
    const domains = [
      '.github.com', '.github.com', 'github.com',
      '.mail.google.com', 'mail.google.com', '.google.com',
      '.chatgpt.com', '.openai.com',
      '.zhihu.com', '.bilibili.com', '.figma.com', '.notion.so',
      '.stackoverflow.com', '.youtube.com', '.developer.mozilla.org',
    ];
    domains.forEach((domain, i) => {
      mockCookies.push({ domain, name: `c${i}`, path: '/', secure: true, httpOnly: true });
    });
  }

  const stripDot = (d) => String(d || '').replace(/^\./, '').toLowerCase();

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
      getAll: async (query = {}) => {
        let items = mockCookies.slice();
        try {
          if (query.url) {
            const host = new URL(query.url).hostname;
            items = items.filter((c) => {
              const cd = stripDot(c.domain);
              return cd === host || host.endsWith(`.${cd}`);
            });
          }
          if (query.domain) {
            const cd = stripDot(query.domain);
            items = items.filter((c) => {
              const d = stripDot(c.domain);
              return d === cd || d.endsWith(`.${cd}`);
            });
          }
        } catch {}
        return items;
      },
    },
    browsingData: {
      remove: async () => {
        await new Promise((r) => setTimeout(r, 120));
        usage = 0;
      },
    },
    history: {
      search: async (query = {}) => {
        let items = mockHistory.slice();
        if (query.startTime) items = items.filter((i) => i.lastVisitTime >= query.startTime);
        if (query.endTime) items = items.filter((i) => i.lastVisitTime < query.endTime);
        if (query.text) {
          const t = String(query.text).toLowerCase();
          items = items.filter(
            (i) => i.url.toLowerCase().includes(t) || i.title.toLowerCase().includes(t),
          );
        }
        const max = query.maxResults && query.maxResults > 0 ? query.maxResults : 100;
        return items.slice(0, max);
      },
      deleteUrl: async ({ url }) => {
        const i = mockHistory.findIndex((h) => h.url === url);
        if (i >= 0) mockHistory.splice(i, 1);
      },
      deleteRange: async ({ startTime, endTime }) => {
        const from = startTime || 0;
        const to = endTime || Date.now();
        for (let i = mockHistory.length - 1; i >= 0; i -= 1) {
          const t = mockHistory[i].lastVisitTime;
          if (t >= from && t <= to) mockHistory.splice(i, 1);
        }
      },
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
