/**
 * 这里的函数会被 chrome.scripting.executeScript 注入到目标页面执行。
 * 硬性约束：函数体必须完全自包含，不能引用任何模块作用域的变量或辅助函数，
 * 否则注入后会抛 ReferenceError。
 */

/** 读取当前站点在浏览器里占用的存储，以及各类存储的条目数量 */
export function probePage() {
  return (async () => {
    const out = {
      usage: null,
      quota: null,
      localStorageKeys: 0,
      indexedDB: [],
      caches: [],
      hasServiceWorker: false,
    };

    try {
      if (navigator.storage && typeof navigator.storage.estimate === 'function') {
        const est = await navigator.storage.estimate();
        out.usage = typeof est.usage === 'number' ? est.usage : null;
        out.quota = typeof est.quota === 'number' ? est.quota : null;
      }
    } catch (e) {}

    try {
      out.localStorageKeys = window.localStorage ? window.localStorage.length : 0;
    } catch (e) {}

    try {
      if (window.indexedDB && typeof window.indexedDB.databases === 'function') {
        const dbs = await window.indexedDB.databases();
        out.indexedDB = (dbs || []).map((d) => d && d.name).filter(Boolean);
      }
    } catch (e) {}

    try {
      if (window.caches && typeof window.caches.keys === 'function') {
        const keys = await window.caches.keys();
        out.caches = keys || [];
      }
    } catch (e) {}

    try {
      out.hasServiceWorker = Boolean(
        navigator.serviceWorker && (navigator.serviceWorker.controller || navigator.serviceWorker.ready),
      );
    } catch (e) {}

    return out;
  })();
}

/**
 * ChatGPT：列出 / 逐条删除云端会话。
 * 只做「先列出、再逐条删除」，不调用任何批量删除接口——避免接口形状变化时误删。
 */
export function chatgptPage(mode) {
  return (async () => {
    const out = { ok: false, total: 0, deleted: 0, error: null };
    try {
      const listRes = await window.fetch('/backend-api/conversations?offset=0&limit=100', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!listRes.ok) {
        out.error = `list:${listRes.status}`;
        return out;
      }
      const data = await listRes.json();
      const list = Array.isArray(data) ? data : data.items || data.data || data.conversations || [];
      out.total = list.length;
      out.ok = true;
      if (mode !== 'delete') return out;

      for (const item of list) {
        const id = item && (item.id || item.conversation_id);
        if (!id) continue;
        try {
          const del = await window.fetch(`/backend-api/conversations/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          if (del.ok) out.deleted += 1;
        } catch (e) {}
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  })();
}

/** Claude：同上，走 /api/organizations/<org>/chat_conversations */
export function claudePage(mode) {
  return (async () => {
    const out = { ok: false, total: 0, deleted: 0, error: null };
    try {
      let orgId = null;
      try {
        orgId = window.localStorage.getItem('lastActiveOrgId');
      } catch (e) {}

      if (!orgId) {
        const orgRes = await window.fetch('/api/organizations', { credentials: 'include' });
        if (orgRes.ok) {
          const orgJson = await orgRes.json();
          const orgs = orgJson.organizations || (Array.isArray(orgJson) ? orgJson : []);
          if (orgs[0]) orgId = orgs[0].id || orgs[0].uuid || null;
        }
      }
      if (!orgId) {
        out.error = 'no-org';
        return out;
      }

      const base = `/api/organizations/${encodeURIComponent(orgId)}/chat_conversations`;
      const listRes = await window.fetch(`${base}?limit=100&offset=0`, { credentials: 'include' });
      if (!listRes.ok) {
        out.error = `list:${listRes.status}`;
        return out;
      }
      const data = await listRes.json();
      const list = data.data || data.conversations || (Array.isArray(data) ? data : []);
      out.total = list.length;
      out.ok = true;
      if (mode !== 'delete') return out;

      for (const item of list) {
        const uuid = item && (item.uuid || item.id);
        if (!uuid) continue;
        try {
          const del = await window.fetch(`${base}/${encodeURIComponent(uuid)}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          if (del.ok) out.deleted += 1;
        } catch (e) {}
      }
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  })();
}
