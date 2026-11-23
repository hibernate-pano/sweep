import { ITEM_DEFS, SCOPE, TIME_RANGES, TIME_RANGE_MAP } from './lib/constants.js';
import { getCleanHistory, getSettings, pushCleanHistory, setSettings } from './lib/settings.js';
import { countCookies, runClean } from './lib/cleaner.js';
import { deleteCloud, matchChatSite, probeCloud } from './lib/chat.js';
import { probePage } from './lib/pageScripts.js';
import {
  formatBytes,
  formatDuration,
  formatWhen,
  hostOf,
  originOf,
  registrableDomain,
} from './lib/util.js';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const RING_R = 40;
const RING_C = 2 * Math.PI * RING_R;
const RING_GAP = 2.4;

const state = {
  settings: null,
  tab: null,
  origin: null,
  host: '',
  probe: null,
  cookies: null,
  chatSite: null,
  cloud: null,
  busy: false,
  segments: [],
};

/* ---------------------------------------------------------------- 主题 */

function applyTheme(pref) {
  const media = window.matchMedia('(prefers-color-scheme: light)');
  const resolve = () => {
    document.documentElement.dataset.theme =
      pref === 'system' ? (media.matches ? 'light' : 'dark') : pref;
  };
  resolve();
  media.addEventListener('change', () => {
    if (pref === 'system') resolve();
  });
}

/* ---------------------------------------------------------------- 初始化 */

init().catch((err) => {
  console.error(err);
  $('site-host').textContent = '读取失败';
  $('site-size').textContent = '';
});

async function init() {
  state.settings = await getSettings();
  applyTheme(state.settings.theme);

  renderScope();
  renderToggles();
  renderWindow();
  renderCustom();
  updateCta();

  await loadTab();
  await renderFooter();
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;
  state.origin = originOf(tab && tab.url);
  state.host = hostOf(tab && tab.url);

  if (!state.origin) {
    $('site-host').textContent = '当前页面不可清理';
    $('site-size').textContent = '';
    $('avatar').textContent = '·';
    renderSubject();
    updateCta();
    return;
  }

  $('site-host').textContent = state.host;
  setFavicon(state.tab.url, state.host);

  const [probe, cookies] = await Promise.all([
    probeSite(state.tab.id),
    countCookies(state.origin),
  ]);
  state.probe = probe;
  state.cookies = cookies;
  renderSubject();
  updateCta();

  const site = matchChatSite(tab.url);
  if (site) {
    state.chatSite = site;
    state.cloud = await probeCloud(state.tab.id, site);
    renderCloud();
  }
}

async function probeSite(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: probePage,
    });
    return results && results[0] ? results[0].result : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- 渲染 */

function setFavicon(url, host) {
  const img = $('favicon-img');
  const letter = $('avatar');
  letter.textContent = (host || '·').charAt(0);

  if (!url) {
    img.hidden = true;
    return;
  }

  // MV3 的站点图标接口：需要 manifest 里声明 favicon 权限。
  img.hidden = false;
  img.onload = () => {
    img.hidden = false;
    letter.hidden = true;
  };
  img.onerror = () => {
    img.hidden = true;
    letter.hidden = false;
  };
  img.src = chrome.runtime.getURL(
    `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`,
  );
}

/** 把站点存储拆成三段，按条目数占比分配圆环 */
function segmentData() {
  const p = state.probe;
  if (!p) return [];
  return [
    { key: 'localStorage', label: '本地存储', count: p.localStorageKeys || 0, tone: 's1' },
    { key: 'indexedDB', label: '数据库', count: (p.indexedDB || []).length, tone: 's2' },
    { key: 'caches', label: '离线缓存', count: (p.caches || []).length, tone: 's3' },
  ];
}

function renderSubject() {
  const scope = state.settings.scope;
  const meter = $('meter');
  const note = $('subject-note');

  if (scope !== SCOPE.CURRENT) {
    meter.hidden = true;
    note.hidden = false;
    note.innerHTML = scopeSummary();
    $('site-size').textContent = '';
    return;
  }

  meter.hidden = false;
  note.hidden = true;

  const usage = state.probe && typeof state.probe.usage === 'number' ? state.probe.usage : null;
  $('site-size').textContent = usage === null ? '' : formatBytes(usage);

  state.segments = segmentData();
  renderRing(state.segments);
  renderLegend(state.segments);
}

function scopeSummary() {
  const s = state.settings;
  const on = ITEM_DEFS.filter((d) => s.items[d.key]).map((d) => d.label);
  if (!on.length) return '没有勾选任何清理项。';

  const target =
    s.scope === SCOPE.ALL
      ? '<b>所有网站</b>'
      : `<b>${s.customOrigins.length} 个自选站点</b>`;
  return `${target}的${on.join('、')}将被清除。${
    s.items.cookies ? '包含 Cookie，会退出这些网站的登录。' : '不含 Cookie，登录状态保留。'
  }`;
}

function renderRing(segments) {
  const g = $('ring-segments');
  g.textContent = '';

  const total = segments.reduce((sum, s) => sum + s.count, 0);
  const core = $('ring-core');
  core.classList.toggle('is-empty', total === 0);

  if (total === 0) {
    $('core-value').textContent = '—';
    $('core-label').textContent = '没有本地数据';
    return;
  }

  $('core-value').textContent = String(total);
  $('core-label').textContent = '项数据';

  let acc = 0;
  for (const seg of segments) {
    if (!seg.count) continue;
    const frac = seg.count / total;
    const len = Math.max(0, frac * RING_C - RING_GAP);
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '50');
    circle.setAttribute('cy', '50');
    circle.setAttribute('r', String(RING_R));
    circle.setAttribute('class', `ring-seg ${seg.tone}`);
    circle.setAttribute('stroke', `var(--${seg.tone})`);
    circle.style.strokeDasharray = `${len} ${RING_C}`;
    circle.style.strokeDashoffset = String(-(acc * RING_C));
    circle.dataset.key = seg.key;
    g.appendChild(circle);
    acc += frac;
  }
}

function renderLegend(items) {
  const box = $('legend');
  box.textContent = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.dataset.key = item.key;

    const swatch = document.createElement('i');
    swatch.className = `swatch ${item.tone || ''}`;

    const label = document.createElement('span');
    label.className = 'lbl';
    label.textContent = item.label;

    const value = document.createElement('span');
    value.className = 'val';
    value.textContent = item.value ?? String(item.count);

    li.append(swatch, label, value);
    box.appendChild(li);
  }
}

function renderScope() {
  document.querySelectorAll('.scope button').forEach((btn) => {
    btn.setAttribute('aria-checked', String(btn.dataset.scope === state.settings.scope));
  });
}

function renderToggles() {
  const box = $('chips');
  box.textContent = '';
  for (const def of ITEM_DEFS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle';
    btn.textContent = def.label;
    btn.title = def.hint;
    btn.dataset.key = def.key;
    btn.setAttribute('aria-pressed', String(Boolean(state.settings.items[def.key])));
    btn.addEventListener('click', async () => {
      const items = { ...state.settings.items };
      items[def.key] = !items[def.key];
      state.settings = await setSettings({ items });
      renderToggles();
      renderWindow();
      renderSubject();
      updateCta();
    });
    box.appendChild(btn);
  }
}

function renderWindow() {
  const row = $('window');
  row.hidden = !state.settings.items.history;
  if (row.hidden) return;

  const box = $('range-opts');
  box.textContent = '';
  for (const range of TIME_RANGES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'window-opt';
    btn.textContent = range.label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(state.settings.since === range.id));
    btn.addEventListener('click', async () => {
      state.settings = await setSettings({ since: range.id });
      renderWindow();
    });
    box.appendChild(btn);
  }
}

function renderCustom() {
  const box = $('custom-list');
  const custom = state.settings.scope === SCOPE.CUSTOM;
  box.hidden = !custom;
  if (!custom) return;

  box.textContent = '';
  for (const origin of state.settings.customOrigins) {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = hostOf(origin);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = '移除';
    remove.addEventListener('click', async () => {
      const customOrigins = state.settings.customOrigins.filter((o) => o !== origin);
      state.settings = await setSettings({ customOrigins });
      renderCustom();
      renderSubject();
      updateCta();
    });

    pill.appendChild(remove);
    box.appendChild(pill);
  }

  if (state.origin && !state.settings.customOrigins.includes(state.origin)) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'pill add';
    add.textContent = `+ ${state.host}`;
    add.addEventListener('click', async () => {
      const customOrigins = [...state.settings.customOrigins, state.origin];
      state.settings = await setSettings({ customOrigins });
      renderCustom();
      renderSubject();
      updateCta();
    });
    box.appendChild(add);
  }
}

function renderCloud() {
  const card = $('cloud-card');
  const site = state.chatSite;
  if (!site) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  card.classList.remove('is-done', 'is-fail');

  if (!state.cloud) {
    $('cloud-title').textContent = `${site.label} 云端会话`;
    $('cloud-sub').textContent = '未能读取，可能未登录或接口已变更';
    $('btn-cloud').hidden = false;
    $('btn-cloud').textContent = '重新检测';
    return;
  }

  if (state.cloud.total === 0) {
    $('cloud-title').textContent = `${site.label} 云端会话`;
    $('cloud-sub').textContent = '账号里没有会话记录';
    $('btn-cloud').hidden = true;
    return;
  }

  $('btn-cloud').hidden = false;
  $('btn-cloud').textContent = '删除';
  $('cloud-title').textContent = `${site.label} 云端还有 ${state.cloud.total} 条会话`;
  $('cloud-sub').textContent = '本地清理不会删掉账号里的记录';
}

function updateCta() {
  const s = state.settings;
  let label;
  if (s.scope === SCOPE.ALL) {
    label = '清空全部网站';
  } else if (s.scope === SCOPE.CUSTOM) {
    label = s.customOrigins.length ? `清空 ${s.customOrigins.length} 个网站` : '先添加要清理的网站';
  } else {
    label = state.origin && state.host ? `清空 ${state.host}` : '当前页面不可清理';
  }
  $('cta-label').textContent = state.busy ? '正在清空…' : label;

  const noPage = !state.origin;
  $('btn-clean').disabled =
    state.busy ||
    (s.scope === SCOPE.CURRENT && noPage) ||
    (s.scope === SCOPE.CUSTOM && s.customOrigins.length === 0);
}

async function renderFooter() {
  const history = await getCleanHistory();
  const last = history[0];
  if (!last) {
    $('last-run').textContent = '尚未清理过';
    return;
  }
  const parts = [`上次 ${formatWhen(last.ts)}`];
  if (last.freed) parts.push(`释放 ${formatBytes(last.freed)}`);
  else if (last.historyRemoved) parts.push(`${last.historyRemoved} 条历史`);
  $('last-run').textContent = parts.join(' · ');
}

/* ---------------------------------------------------------------- 交互 */

$('scope').addEventListener('click', async (event) => {
  const btn = event.target.closest('button');
  if (!btn) return;
  state.settings = await setSettings({ scope: btn.dataset.scope });
  renderScope();
  renderCustom();
  renderSubject();
  updateCta();
});

$('btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('btn-reset').addEventListener('click', async () => {
  state.settings = await setSettings({
    scope: SCOPE.CURRENT,
    items: { cache: true, siteData: true, cookies: false, history: true },
    since: 'all',
  });
  renderScope();
  renderToggles();
  renderWindow();
  renderSubject();
  updateCta();
});

$('btn-cloud').addEventListener('click', async () => {
  if (!state.chatSite) return;
  const site = state.chatSite;

  if (!state.cloud) {
    $('btn-cloud').disabled = true;
    $('cloud-title').textContent = `正在检测 ${site.label} 云端会话…`;
    $('cloud-sub').textContent = '';
    state.cloud = await probeCloud(state.tab.id, site);
    $('btn-cloud').disabled = false;
    renderCloud();
    return;
  }

  const count = state.cloud.total;
  const confirmed = await confirmDialog({
    title: `删除 ${site.label} 的云端会话？`,
    body: `将永久删除账号里的 ${count} 条会话记录，无法撤销。`,
    okText: '永久删除',
  });
  if (!confirmed) return;

  await applyCloudDelete(count);
});

$('btn-clean').addEventListener('click', () => {
  handleClean().catch((err) => {
    console.error(err);
    state.busy = false;
    updateCta();
  });
});

/** 当前站点是否在「保留登录状态」名单里 */
function currentIsKept() {
  if (!state.host) return false;
  const reg = registrableDomain(state.host);
  return state.settings.keepLogin.some((h) => registrableDomain(h) === reg);
}

async function handleClean() {
  if (state.busy) return;

  const s = state.settings;
  const scope = s.scope;
  const origins =
    scope === SCOPE.ALL ? [] : scope === SCOPE.CURRENT ? [state.origin] : [...s.customOrigins];

  if (scope !== SCOPE.ALL && origins.length === 0) {
    showNotice('没有可清理的站点', '先在下面添加想清理的网站');
    return;
  }

  if (scope === SCOPE.CURRENT && currentIsKept()) {
    showNotice(`${state.host} 在保留名单里`, '到设置里移除它，或换一个范围');
    return;
  }

  // 云端会话只在「当前站点确实在清理范围内」时才提示删除。
  const originInScope =
    scope === SCOPE.CURRENT || (scope === SCOPE.CUSTOM && origins.includes(state.origin));
  const cloudCount = originInScope && state.chatSite && state.cloud ? state.cloud.total : 0;

  // 所有不可逆的部分合成一次确认，分开弹两个框只会让人盲目连点。
  const willLogoutAll = scope === SCOPE.ALL && s.items.cookies;

  if (willLogoutAll || cloudCount > 0) {
    const risks = [];
    if (willLogoutAll) risks.push('把你从几乎所有网站登出，包括正在使用的工作账号');
    if (cloudCount > 0) {
      risks.push(`永久删除 ${state.chatSite.label} 账号里的 ${cloudCount} 条会话`);
    }
    const both = risks.length > 1;

    const confirmed = await confirmDialog({
      title: both ? '确认执行两项不可恢复的操作？' : '确认清理？',
      body: `这次清理会${risks.join('，并且会')}，${both ? '两者都无法撤销。' : '无法撤销。'}`,
      okText: '确认清理',
    });
    if (!confirmed) return;

    if (cloudCount > 0) await applyCloudDelete(cloudCount);
  }

  state.busy = true;
  updateCta();
  $('btn-clean').classList.add('is-busy');

  const usageBefore =
    scope === SCOPE.CURRENT && state.probe && typeof state.probe.usage === 'number'
      ? state.probe.usage
      : null;

  const report = await runClean({
    scope,
    origins,
    since: TIME_RANGE_MAP[s.since] ? TIME_RANGE_MAP[s.since].ms : 0,
    items: s.items,
    keepLogin: s.keepLogin,
    onProgress: (step) => {
      drainSegment(step);
      markToggleDone(step);
    },
  });

  state.busy = false;
  $('btn-clean').classList.remove('is-busy');

  // 当前站点：重新探测一次，用前后差值报告真实释放量。
  let freed = null;
  if (scope === SCOPE.CURRENT && state.tab && state.tab.id) {
    state.probe = await probeSite(state.tab.id);
    if (usageBefore !== null && state.probe && typeof state.probe.usage === 'number') {
      freed = Math.max(0, usageBefore - state.probe.usage);
    }
    $('site-size').textContent =
      state.probe && typeof state.probe.usage === 'number'
        ? formatBytes(state.probe.usage)
        : '';
  }

  showResult(report, freed);
  updateCta();

  await pushCleanHistory({
    scope,
    freed,
    historyRemoved: report.historyRemoved,
    durationMs: report.durationMs,
    items: report.items.map((i) => i.key),
  });
  await renderFooter();
}

/** 清掉圆环里属于该步骤的段 */
function drainSegment(step) {
  const map = { cache: ['caches'], siteData: ['localStorage', 'indexedDB'] };
  const keys = map[step];
  if (!keys) return;

  document.querySelectorAll('.ring-seg').forEach((circle) => {
    if (!keys.includes(circle.dataset.key)) return;
    circle.style.strokeDasharray = `0 ${RING_C}`;
  });
  animateCore();
}

let coreAnimation = null;

function animateCore() {
  const core = $('core-value');
  const label = $('core-label');
  const from = Number(core.textContent);
  if (!Number.isFinite(from) || from <= 0) return;

  const start = performance.now();
  if (coreAnimation) cancelAnimationFrame(coreAnimation);
  const tick = (now) => {
    const t = Math.min(1, (now - start) / 450);
    const value = Math.round(from * (1 - t));
    core.textContent = String(value);
    if (t < 1) {
      coreAnimation = requestAnimationFrame(tick);
    } else {
      core.textContent = '✓';
      $('ring-core').classList.add('is-empty');
      label.textContent = '已清空';
      coreAnimation = null;
    }
  };
  coreAnimation = requestAnimationFrame(tick);
}

function markToggleDone(step) {
  const btn = document.querySelector(`.toggle[data-key="${step}"]`);
  if (btn) btn.classList.add('is-done');
}

function showNotice(title, sub) {
  $('subject-note').hidden = false;
  $('meter').hidden = true;
  $('subject-note').innerHTML = `<b>${title}</b><br>${sub}`;
  $('site-size').textContent = '';
}

/** 清理完成后，图例换成逐项结果，圆环中心变成「已清空」 */
function showResult(report, freed) {
  const meter = $('meter');
  const note = $('subject-note');

  if (state.settings.scope === SCOPE.CURRENT) {
    meter.hidden = false;
    note.hidden = true;

    const rows = report.items.map((item) => ({
      key: item.key,
      label: item.label,
      value:
        item.status === 'error'
          ? '失败'
          : item.status === 'skipped'
            ? '已跳过'
            : item.note || '已清除',
      failed: item.status === 'error',
      skipped: item.status === 'skipped',
    }));

    if (!rows.length) {
      rows.push({ key: 'none', label: '没有勾选任何清理项', value: '' });
    }
    renderLegend(rows);

    const core = $('ring-core');
    core.classList.add('is-empty');
    $('core-value').textContent = '✓';
    $('core-label').textContent = '已清空';

    const meta = [];
    if (freed) meta.push(`释放 ${formatBytes(freed)}`);
    meta.push(`用时 ${formatDuration(report.durationMs)}`);
    $('site-size').textContent = meta.join(' · ');
  } else {
    meter.hidden = true;
    note.hidden = false;
    const done = report.items.filter((i) => i.status === 'done').length;
    note.innerHTML = `<b>${done} 项已清除</b><br>${
      freed ? `释放 ${formatBytes(freed)} · ` : ''
    }用时 ${formatDuration(report.durationMs)}`;
  }
}

/**
 * 执行云端会话删除，并把真实结果写回卡片。
 * deleted === 0 但原本有会话，说明接口拒绝了请求，必须报失败而不是「已删除 0 条」。
 */
async function applyCloudDelete(expectedTotal) {
  const card = $('cloud-card');
  const site = state.chatSite;
  if (!card || !site) return;

  card.classList.remove('is-done', 'is-fail');
  $('cloud-title').textContent = `正在删除 ${site.label} 云端会话…`;
  $('cloud-sub').textContent = '不要关闭这个面板';
  $('btn-cloud').disabled = true;

  const result = await deleteCloud(state.tab.id, site);

  $('btn-cloud').disabled = false;

  if (result && result.ok && (result.deleted > 0 || expectedTotal === 0)) {
    state.cloud = { total: 0 };
    card.classList.add('is-done');
    $('cloud-title').textContent = `已删除 ${result.deleted} 条云端会话`;
    $('cloud-sub').textContent = '账号里的历史记录也已清除';
    $('btn-cloud').hidden = true;
    return;
  }

  state.cloud = null;
  card.classList.add('is-fail');
  $('cloud-title').textContent = '云端会话删除失败';
  $('cloud-sub').textContent = '接口可能已变更，请到网站内手动删除';
  $('btn-cloud').hidden = false;
  $('btn-cloud').textContent = '重新检测';
}

/* ---------------------------------------------------------------- 对话框 */

function confirmDialog({ title, body, okText }) {
  const dlg = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = okText || '确认';
  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}
