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

export async function setSettings(patch) {
  const current = await getSettings();
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
