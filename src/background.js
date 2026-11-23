import { SCOPE, TIME_RANGE_MAP } from './lib/constants.js';
import { getSettings, pushCleanHistory } from './lib/settings.js';
import { runClean } from './lib/cleaner.js';

const ALARM_NAME = 'daily-clean';
const EXIT_FLAG = 'exitCleanPending';

async function scheduleDaily(settings) {
  await chrome.alarms.clear(ALARM_NAME);
  if (!settings.auto.daily) return;
  const [hour, minute] = String(settings.auto.dailyTime || '23:30')
    .split(':')
    .map((n) => Number(n) || 0);
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  chrome.alarms.create(ALARM_NAME, { when: next.getTime(), periodInMinutes: 24 * 60 });
}

async function flashBadge(text) {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#10a37f' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } catch {}
}

async function autoClean(reason, settings) {
  // 自动清理没有「当前标签页」这个概念。绝不能把 current 静默降级成 all，
  // 那会让开着自动清理的人被悄悄清空整个浏览器。current 一律跳过。
  if (settings.scope === SCOPE.CURRENT) {
    console.info('[Clean My Webbrowser] 默认范围是「当前网站」，自动清理跳过（没有当前页概念）');
    return null;
  }

  const scope = settings.scope;
  const origins = scope === SCOPE.CUSTOM ? [...settings.customOrigins] : [];

  if (scope === SCOPE.CUSTOM && origins.length === 0) return null;

  const report = await runClean({
    scope,
    origins,
    since: TIME_RANGE_MAP[settings.since] ? TIME_RANGE_MAP[settings.since].ms : 0,
    items: settings.items,
    keepLogin: settings.keepLogin,
  });

  await pushCleanHistory({
    scope,
    freed: null,
    historyRemoved: report.historyRemoved,
    durationMs: report.durationMs,
    items: report.items.map((i) => i.key),
    auto: reason,
  });
  await flashBadge('✓');
  return report;
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await scheduleDaily(settings);
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  const raw = await chrome.storage.local.get(EXIT_FLAG);
  const pending = Boolean(raw[EXIT_FLAG]);
  if (pending) await chrome.storage.local.remove(EXIT_FLAG);

  if (settings.auto.onStartup || pending) {
    await autoClean(pending ? 'exit-deferred' : 'startup', settings);
  }
  await scheduleDaily(settings);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const settings = await getSettings();
  if (settings.auto.daily) await autoClean('daily', settings);
});

chrome.windows.onRemoved.addListener(async () => {
  const settings = await getSettings();
  if (!settings.auto.onExit) return;
  const windows = await chrome.windows.getAll();
  if (windows.length > 0) return;
  await chrome.storage.local.set({ [EXIT_FLAG]: true });
  await autoClean('exit', settings);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const settings = await getSettings();
  await scheduleDaily(settings);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'clean-now') return false;
  getSettings()
    .then((settings) => autoClean('manual', settings))
    .then((report) => sendResponse({ ok: true, report }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});
