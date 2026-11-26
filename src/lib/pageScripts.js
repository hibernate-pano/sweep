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
