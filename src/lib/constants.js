export const SCOPE = Object.freeze({
  CURRENT: 'current',
  ALL: 'all',
  CUSTOM: 'custom',
});

export const SCOPE_LABEL = {
  [SCOPE.CURRENT]: '当前网站',
  [SCOPE.ALL]: '全部网站',
  [SCOPE.CUSTOM]: '自选站点',
};

/**
 * 四个可清理项。types 对应 chrome.browsingData 的 DataTypeSet 成员；
 * history 不走 browsingData，由 chrome.history 单独处理。
 */
export const ITEM_DEFS = [
  {
    key: 'cache',
    label: '缓存',
    hint: '磁盘缓存、Cache Storage',
    types: ['cache', 'cacheStorage'],
  },
  {
    key: 'siteData',
    label: '站点数据',
    hint: 'LocalStorage、IndexedDB、Service Worker（本地会话、偏好设置）',
    types: ['localStorage', 'indexedDB', 'fileSystems', 'serviceWorkers'],
  },
  {
    key: 'cookies',
    label: 'Cookie',
    hint: '会退出该网站的登录状态',
    types: ['cookies', 'formData'],
  },
  {
    key: 'history',
    label: '历史记录',
    hint: '浏览历史',
    types: [],
  },
];

export const ITEM_MAP = Object.fromEntries(ITEM_DEFS.map((d) => [d.key, d]));

export const TIME_RANGES = [
  { id: 'all', label: '全部', ms: 0 },
  { id: 'hour', label: '1 小时', ms: 3600 * 1000 },
  { id: 'day', label: '24 小时', ms: 86400 * 1000 },
  { id: 'week', label: '7 天', ms: 604800 * 1000 },
];

export const TIME_RANGE_MAP = Object.fromEntries(TIME_RANGES.map((r) => [r.id, r]));

export const DEFAULT_SETTINGS = {
  theme: 'system', // system | dark | light
  scope: SCOPE.ALL,
  items: { cache: true, siteData: true, cookies: false, history: true },
  since: 'all',
  customOrigins: [],
  keepLogin: [],
  auto: {
    onStartup: false,
    onExit: false,
    daily: false,
    dailyTime: '23:30',
  },
};

export const CLEAN_HISTORY_LIMIT = 30;
