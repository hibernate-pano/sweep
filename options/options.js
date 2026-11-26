import { ITEM_DEFS, SCOPE, TIME_RANGES } from '../src/lib/constants.js';
import { clearCleanHistory, getCleanHistory, getSettings, setSettings } from '../src/lib/settings.js';
import { formatBytes, formatWhen, hostOf, registrableDomain } from '../src/lib/util.js';

const $ = (id) => document.getElementById(id);

let settings = null;

/* ---------------------------------------------------------------- 主题 */

/**
 * 主题只注册一个监听器。
 *
 * 之前每次 applyTheme 都新加一个 matchMedia 监听，旧的监听器还闭包着旧的偏好：
 * 用户显式选了「深色」之后，系统主题一变，旧监听器就会按「跟随系统」把主题改回去。
 */
const media = window.matchMedia('(prefers-color-scheme: light)');
let themePref = 'system';

function resolveTheme() {
  document.documentElement.dataset.theme =
    themePref === 'system' ? (media.matches ? 'light' : 'dark') : themePref;
}

function applyTheme(pref) {
  themePref = pref;
  resolveTheme();
}

media.addEventListener('change', () => {
  if (themePref === 'system') resolveTheme();
});

/* ---------------------------------------------------------------- 初始化 */

init().catch((err) => {
  console.error(err);
});

async function init() {
  settings = await getSettings();
  applyTheme(settings.theme);

  bindSegments();
  renderTheme();
  renderScope();
  renderItems();
  renderSince();
  renderCustom();
  await renderRecent();
  renderKeep();
  renderAuto();
  await renderHistory();

  const manifest = chrome.runtime.getManifest();
  $('version').textContent = manifest.version;

  try {
    const commands = await chrome.commands.getAll();
    const action = commands.find((c) => c.name === '_execute_action');
    $('shortcut').textContent = (action && action.shortcut) || '未设置';
  } catch {
    $('shortcut').textContent = '未设置';
  }
}

/* ---------------------------------------------------------------- 渲染 */

function markActive(container, attribute, value) {
  container.querySelectorAll('button').forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset[attribute] === value));
  });
}

function renderTheme() {
  markActive($('theme-seg'), 'theme', settings.theme);
}

function renderScope() {
  markActive($('scope-seg'), 'scope', settings.scope);

  // 自动清理跟着默认范围走，得说清楚两种范围分别会发生什么。
  const hint = $('auto-hint');
  if (!hint) return;
  hint.textContent =
    settings.scope === SCOPE.CURRENT
      ? '按上面的默认范围执行一次。默认范围是「当前网站」时，后台没有「当前标签页」的概念，会直接跳过。'
      : '按上面的默认范围执行一次。默认范围是「全部网站」时，每次触发都会清掉所有网站的浏览历史。';
}

/* 事件只绑定一次，渲染函数只负责更新选中态，避免重复绑定。 */
function bindSegments() {
  $('theme-seg').addEventListener('click', async (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    settings = await setSettings({ theme: btn.dataset.theme });
    applyTheme(settings.theme);
    renderTheme();
  });

  $('scope-seg').addEventListener('click', async (event) => {
    const btn = event.target.closest('button');
    if (!btn) return;
    settings = await setSettings({ scope: btn.dataset.scope });
    renderScope();
  });
}

function renderItems() {
  const box = $('item-chips');
  box.textContent = '';
  for (const def of ITEM_DEFS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = def.label;
    btn.title = def.hint;
    btn.setAttribute('aria-pressed', String(Boolean(settings.items[def.key])));
    btn.addEventListener('click', async () => {
      const items = { ...settings.items };
      items[def.key] = !items[def.key];
      settings = await setSettings({ items });
      renderItems();
    });
    box.appendChild(btn);
  }
}

function renderSince() {
  const seg = $('since-seg');
  seg.textContent = '';
  for (const range of TIME_RANGES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = range.label;
    btn.dataset.since = range.id;
    // aria-checked 只在 role=radio 上有效，缺了就是非法 ARIA。
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(settings.since === range.id));
    btn.addEventListener('click', async () => {
      settings = await setSettings({ since: range.id });
      renderSince();
    });
    seg.appendChild(btn);
  }
}

function renderCustom() {
  const box = $('custom-list');
  box.textContent = '';
  if (!settings.customOrigins.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有自选站点';
    box.appendChild(empty);
  }
  for (const origin of settings.customOrigins) {
    box.appendChild(makeTag(hostOf(origin), async () => {
      settings = await setSettings({
        customOrigins: settings.customOrigins.filter((o) => o !== origin),
      });
      renderCustom();
      renderRecent();
    }));
  }
}

/**
 * 最近 7 天去过的站，按主域名去重后给一个快捷入口。
 * 名单是配置，配置会烂——让用户点一下就能加，比教他手打域名省事。
 */
async function renderRecent() {
  const row = $('recent-row');
  const box = $('recent-chips');
  box.textContent = '';

  const existing = new Set(settings.customOrigins);
  const usable = (await recentOrigins()).filter((o) => !existing.has(o)).slice(0, 8);
  row.hidden = !usable.length;
  if (!usable.length) return;

  for (const origin of usable) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = hostOf(origin);
    btn.title = '加入自选站点';
    btn.addEventListener('click', async () => {
      settings = await setSettings({
        customOrigins: [...settings.customOrigins, origin],
      });
      renderCustom();
      renderRecent();
    });
    box.appendChild(btn);
  }
}

async function recentOrigins() {
  try {
    const hits = await chrome.history.search({
      text: '',
      startTime: Date.now() - 7 * 24 * 60 * 60 * 1000,
      maxResults: 300,
    });
    const seen = new Map();
    for (const hit of hits) {
      const host = hostOf(hit.url || '');
      if (!host) continue;
      const domain = registrableDomain(host);
      if (!domain || seen.has(domain)) continue;
      seen.set(domain, `https://${domain}`);
    }
    return [...seen.values()];
  } catch {
    return [];
  }
}

function renderKeep() {
  const box = $('keep-list');
  box.textContent = '';
  if (!settings.keepLogin.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有需要保留登录的网站';
    box.appendChild(empty);
  }
  for (const host of settings.keepLogin) {
    box.appendChild(makeTag(host, async () => {
      settings = await setSettings({
        keepLogin: settings.keepLogin.filter((h) => h !== host),
      });
      renderKeep();
    }));
  }
}

function makeTag(label, onRemove) {
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = label;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = '移除';
  remove.addEventListener('click', onRemove);

  tag.appendChild(remove);
  return tag;
}

function renderAuto() {
  $('auto-startup').checked = Boolean(settings.auto.onStartup);
  $('auto-exit').checked = Boolean(settings.auto.onExit);
  $('auto-daily').checked = Boolean(settings.auto.daily);
  $('auto-daily-time').value = settings.auto.dailyTime;
  $('auto-daily-time').disabled = !settings.auto.daily;
}

async function renderHistory() {
  const box = $('history');
  const history = await getCleanHistory();
  box.textContent = '';

  if (!history.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有清理记录';
    box.appendChild(empty);
    return;
  }

  for (const entry of history) {
    const row = document.createElement('div');
    row.className = 'history-row';

    const when = document.createElement('span');
    when.className = 'h-when';
    const scopeLabel =
      entry.scope === SCOPE.ALL ? '全部网站' : entry.scope === SCOPE.CUSTOM ? '自选站点' : '当前网站';
    when.textContent = `${formatWhen(entry.ts)} · ${scopeLabel}${entry.auto ? ` · ${entry.auto}` : ''}`;

    const meta = document.createElement('span');
    meta.className = 'h-meta';
    const parts = [];
    if (entry.freed) parts.push(`释放 ${formatBytes(entry.freed)}`);
    if (entry.historyRemoved) parts.push(`${entry.historyRemoved} 条历史`);
    meta.textContent = parts.join(' · ') || '已完成';

    row.append(when, meta);
    box.appendChild(row);
  }
}

/* ---------------------------------------------------------------- 事件 */

$('custom-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('custom-input');
  const raw = input.value.trim();
  if (!raw) return;
  const host = hostOf(raw.includes('://') ? raw : `https://${raw}`);
  if (!host) return;
  const origin = `https://${host}`;
  if (!settings.customOrigins.includes(origin)) {
    settings = await setSettings({ customOrigins: [...settings.customOrigins, origin] });
    renderCustom();
    renderRecent();
  }
  input.value = '';
});

$('keep-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('keep-input');
  const raw = input.value.trim();
  if (!raw) return;
  const host = registrableDomain(hostOf(raw.includes('://') ? raw : `https://${raw}`));
  if (!host) return;
  if (!settings.keepLogin.includes(host)) {
    settings = await setSettings({ keepLogin: [...settings.keepLogin, host] });
    renderKeep();
  }
  input.value = '';
});

$('auto-startup').addEventListener('change', async (event) => {
  settings = await setSettings({ auto: { ...settings.auto, onStartup: event.target.checked } });
  renderAuto();
});

$('auto-exit').addEventListener('change', async (event) => {
  settings = await setSettings({ auto: { ...settings.auto, onExit: event.target.checked } });
  renderAuto();
});

$('auto-daily').addEventListener('change', async (event) => {
  settings = await setSettings({ auto: { ...settings.auto, daily: event.target.checked } });
  renderAuto();
});

$('auto-daily-time').addEventListener('change', async (event) => {
  const value = event.target.value || '23:30';
  settings = await setSettings({ auto: { ...settings.auto, dailyTime: value } });
  renderAuto();
});

$('clear-history').addEventListener('click', async () => {
  await clearCleanHistory();
  await renderHistory();
});
