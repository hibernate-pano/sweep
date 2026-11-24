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
    hint: '磁盘缓存、Cache Storage 离线缓存包。清了只是让网页重新下载一次，不影响登录。',
    types: ['cache', 'cacheStorage'],
  },
  {
    key: 'siteData',
    label: '站点数据',
    hint:
      'LocalStorage、IndexedDB、Service Worker、文件系统。很多站把登录令牌也存在这里，清了照样会退出登录。',
    types: ['localStorage', 'indexedDB', 'fileSystems', 'serviceWorkers'],
  },
  {
    key: 'cookies',
    label: 'Cookie',
    hint: 'Cookie 和自动填充保存的表单数据。清了会退出这些网站的登录。',
    types: ['cookies', 'formData'],
  },
  {
    key: 'history',
    label: '历史记录',
    hint: '浏览历史。地址栏里输入过的网址也在里面。',
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
