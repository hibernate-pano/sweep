import { CLEAN_HISTORY_LIMIT, DEFAULT_SETTINGS } from './constants.js';

const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'cleanHistory';

export async function getSettings() {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = raw[SETTINGS_KEY] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    items: { ...DEFAULT_SETTINGS.items, ...(stored.items || {}) },
    auto: { ...DEFAULT_SETTINGS.auto, ...(stored.auto || {}) },
    customOrigins: Array.isArray(stored.customOrigins) ? stored.customOrigins : [],
    keepLogin: Array.isArray(stored.keepLogin) ? stored.keepLogin : [],
  };
}

/**
 * 写设置。
 *
 * 这里做的是「读出来 → 改几个字段 → 整份写回」，所以两个写操作撞在一起时，
 * 后写的那份会把先写的那份覆盖掉（切范围的同时改时间范围，范围就白改了）。
 * 用一条链把所有写操作串起来，合并就一定发生在最新的一份上。
 */
let writeChain = Promise.resolve();

/**
 * 按「当前状态」改一次设置。
 *
 * setSettings 传的是「要写成什么样」，如果这个值是读快照算出来的，
 * 两次快速操作就会用同一份旧快照互相覆盖（点「缓存」再点「站点数据」，
 * 第一次的改动被冲掉）。这里把「怎么改」交给函数，在链上最新的状态里执行。
 */
export function updateSettings(mutate) {
  const run = writeChain.then(async () => {
    const current = await getSettings();
    const patch = (await mutate(current)) || {};
    const next = {
      ...current,
      ...patch,
      items: { ...current.items, ...(patch.items || {}) },
      auto: { ...current.auto, ...(patch.auto || {}) },
      customOrigins: patch.customOrigins ?? current.customOrigins,
      keepLogin: patch.keepLogin ?? current.keepLogin,
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  });

  // 一条失败不能把后面的写操作一起卡住。
  writeChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

export function setSettings(patch) {
  return updateSettings(() => patch);
}

export async function getCleanHistory() {
  const raw = await chrome.storage.local.get(HISTORY_KEY);
  return Array.isArray(raw[HISTORY_KEY]) ? raw[HISTORY_KEY] : [];
}

export async function pushCleanHistory(entry) {
  const list = await getCleanHistory();
  list.unshift({ ...entry, ts: entry.ts || Date.now() });
  await chrome.storage.local.set({ [HISTORY_KEY]: list.slice(0, CLEAN_HISTORY_LIMIT) });
  return list;
}

export async function clearCleanHistory() {
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
}
