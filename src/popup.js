import { ITEM_DEFS, SCOPE, SCOPE_LABEL, TIME_RANGES, TIME_RANGE_MAP } from './lib/constants.js';
import {
  getCleanHistory,
  getSettings,
  pushCleanHistory,
  setSettings,
  updateSettings,
} from './lib/settings.js';
import { runClean } from './lib/cleaner.js';
import { measureFootprint } from './lib/footprint.js';
import { probePage } from './lib/pageScripts.js';
import {
  formatBytes,
  formatCompact,
  formatCount,
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
  busy: false,
  segments: [],
  footprint: null,
  footprintToken: 0,
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
  // 范围不是「当前网站」时，圆盘改成整个浏览器的足迹统计。异步去数，不挡面板打开。
  refreshFootprint().catch(() => {});
  await renderFooter();
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;
  state.origin = originOf(tab && tab.url);
  state.host = hostOf(tab && tab.url);
  // 站点变了，「保留名单」标记要跟着重画。
  renderToggles();

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

  state.probe = await probeSite(state.tab.id);
  renderSubject();
  updateCta();
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

/**
 * 整个浏览器的足迹构成。
 *
 * 全部网站/自选范围拿不到「缓存占了多少字节」——扩展没有这个接口。
 * 能数清楚的就数清楚：历史条数、Cookie 条数、涉及多少个网站。
 */
function footprintSegments() {
  const fp = state.footprint;
  if (!fp) return [];
  const items = state.settings.items;
  const plus = (capped) => (capped ? '+' : '');

  return [
    {
      key: 'history',
      label: '浏览历史',
      count: fp.history.count,
      tone: 's1',
      value: `${formatCount(fp.history.count)}${plus(fp.history.capped)} 条`,
      off: !items.history,
    },
    {
      key: 'cookies',
      label: 'Cookie',
      count: fp.cookies.count,
      tone: 's2',
      value: `${formatCount(fp.cookies.count)} 条`,
      off: !items.cookies,
    },
    {
      key: 'sites',
      label: state.settings.scope === SCOPE.ALL ? '访问过的网站' : '选中的网站',
      count: fp.sites.count,
      tone: 's3',
      value: `${formatCount(fp.sites.count)}${plus(fp.sites.capped)} 个`,
      off: false,
    },
  ];
}

function renderSubject() {
  const scope = state.settings.scope;
  const meter = $('meter');
  const note = $('subject-note');

  // 三种范围都要显示这句摘要：它写着「会不会退出登录」「时间范围管到哪些」，
  // 这些是最容易踩坑的地方，不能只在「全部网站」范围才看得到。
  $('subject-line').hidden = scope !== SCOPE.CURRENT;
  meter.hidden = false;
  note.hidden = false;
  note.innerHTML = scopeSummary();

  if (scope !== SCOPE.CURRENT) {
    if (!state.footprint) {
      // 还在数：先占个位，别让圆盘空着。
      renderRing([], { value: '…', label: '统计中', empty: true });
      renderLegend([{ key: 'none', label: '正在统计浏览足迹', value: '' }]);
      return;
    }

    const segs = footprintSegments();
    renderRing(segs, { value: formatCompact(state.footprint.total), label: '项足迹' });
    renderLegend(
      segs.map((s) => ({
        ...s,
        // 没勾的清理项：数据还在，但这次不清。标出来，别让人误读。
        tag: s.off ? '未清理' : '',
      })),
    );
    return;
  }

  const usage = state.probe && typeof state.probe.usage === 'number' ? state.probe.usage : null;
  $('site-size').textContent = usage === null ? '' : formatBytes(usage);

  state.segments = segmentData();
  renderRing(state.segments);
  renderLegend(state.segments);
}

/** 异步统计整个浏览器的足迹。范围、时间范围变了都要重新数。 */
async function refreshFootprint() {
  const token = (state.footprintToken += 1);
  const s = state.settings;

  if (s.scope === SCOPE.CURRENT) {
    state.footprint = null;
    renderSubject();
    return;
  }

  state.footprint = null;
  renderSubject();

  const fp = await measureFootprint({
    scope: s.scope,
    origins: s.customOrigins,
    since: TIME_RANGE_MAP[s.since] ? TIME_RANGE_MAP[s.since].ms : 0,
    keepLogin: s.keepLogin,
  });

  // 期间用户又切了范围或改了时间，这批数就作废了。
  if (token !== state.footprintToken) return;

  state.footprint = fp;
  renderSubject();
}

function scopeSummary() {
  const s = state.settings;
  const on = ITEM_DEFS.filter((d) => s.items[d.key]);
  if (!on.length) return '没有勾选任何清理项。';

  const target =
    s.scope === SCOPE.ALL
      ? '<b>所有网站</b>'
      : s.scope === SCOPE.CUSTOM
        ? `<b>${s.customOrigins.length} 个自选站点</b>`
        : `<b>${state.host || '当前网站'}</b>`;
  const range = TIME_RANGE_MAP[s.since];
  const names = on.map((d) => d.label).join('、');

  // 时间范围是浏览器的全局过滤：缓存、站点数据、Cookie、历史都按它筛。
  const rangeLine = range && range.ms ? `，只限最近 ${range.label}以内` : '';

  // 「会不会登出」要说准：Cookie 和站点数据都会。站点数据不能漏——
  // 很多站把登录令牌存在 localStorage 里，只提 Cookie 会让人以为还登录着。
  const keepNote = s.keepLogin.length ? '（保留名单里的除外）' : '';
  let loginLine;
  if (s.items.cookies && s.items.siteData) {
    loginLine = `包含 Cookie 和站点数据，会退出这些网站的登录${keepNote}。`;
  } else if (s.items.cookies) {
    loginLine = `包含 Cookie，会退出这些网站的登录${keepNote}。`;
  } else if (s.items.siteData) {
    loginLine = `包含站点数据，很多站把登录令牌存在这里，也会退出登录${keepNote}。`;
  } else {
    loginLine = '不含 Cookie 和站点数据，登录状态保留。';
  }

  return `${target}的${names}将被清除${rangeLine}。${loginLine}`;
}

function renderRing(segments, center) {
  const g = $('ring-segments');
  g.textContent = '';

  const total = segments.reduce((sum, s) => sum + s.count, 0);
  const core = $('ring-core');
  core.classList.toggle('is-empty', total === 0 && !center);

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
    // 没勾的清理项：数据还在，但这次不清。环上也压暗，跟图例保持一致。
    if (seg.off) circle.style.opacity = '0.4';
    g.appendChild(circle);
    acc += frac;
  }

  // 中心可以另给——统计中、进度百分比、「已清空」都走这条路。
  if (center) {
    $('core-value').textContent = center.value;
    $('core-label').textContent = center.label;
    if (center.empty) core.classList.add('is-empty');
    return;
  }

  if (total === 0) {
    $('core-value').textContent = '—';
    $('core-label').textContent = '没有本地数据';
    return;
  }

  $('core-value').textContent = String(total);
  $('core-label').textContent = '项数据';
}

function renderLegend(items) {
  const box = $('legend');
  box.textContent = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.dataset.key = item.key;
    if (item.state) li.classList.add(`is-${item.state}`);
    if (item.off) li.dataset.off = '1';

    const swatch = document.createElement('i');
    swatch.className = `swatch ${item.tone || ''}`;

    const label = document.createElement('span');
    label.className = 'lbl';
    label.textContent = item.label;

    const value = document.createElement('span');
    value.className = 'val';
    value.textContent = item.value ?? String(item.count);

    li.append(swatch, label, value);

    if (item.tag) {
      const tag = document.createElement('i');
      tag.className = 'tag';
      tag.textContent = item.tag;
      li.appendChild(tag);
    }

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
  // 当前站点在保留名单里时，这两项会被保住，标出来，免得以为没生效。
  const kept = state.settings.scope === SCOPE.CURRENT && currentIsKept();
  for (const def of ITEM_DEFS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toggle';
    btn.textContent = def.label;
    const isKept = kept && (def.key === 'siteData' || def.key === 'cookies');
    btn.title = isKept ? '在保留登录名单里，这次不会被清除' : def.hint;
    btn.dataset.key = def.key;
    if (isKept) btn.dataset.kept = '1';
    btn.setAttribute('aria-pressed', String(Boolean(state.settings.items[def.key])));
    btn.addEventListener('click', async () => {
      if (state.busy) return;
      // 用 updateSettings：改的是「当前状态」，不是一份读出来的旧快照。
      // 快速点两个开关时，两次都作用在最新的一份上，不会互相冲掉。
      state.settings = await updateSettings((s) => ({
        items: { ...s.items, [def.key]: !s.items[def.key] },
      }));
      renderToggles();
      renderWindow();
      renderSubject();
      updateCta();
      // 按钮是重画过的，焦点丢了——放回刚点的那个，键盘用户不用重新 Tab。
      refocus('chips', def.key);
    });
    box.appendChild(btn);
  }
  renderKeepNote(kept);
}

/** 重建 DOM 之后把焦点放回原来的那个控件上。 */
function refocus(containerId, key) {
  const btn = document.querySelector(`#${containerId} [data-key="${key}"]`);
  if (btn) btn.focus();
}

/** 说清楚哪两项被保住了——方格太小，塞不下「保留」两个字 */
function renderKeepNote(kept) {
  const note = $('keep-note');
  note.hidden = !kept;
  if (kept) note.textContent = '本站在保留登录名单里：Cookie 和站点数据不会被清除。';
}

function renderWindow() {
  // 时间范围对所有清理项都生效（浏览器的 since 是全局过滤），
  // 所以这一行一直显示——藏起来会让人以为它只管历史记录。
  const box = $('range-opts');
  box.textContent = '';
  for (const range of TIME_RANGES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'window-opt';
    btn.textContent = range.label;
    btn.dataset.key = range.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(state.settings.since === range.id));
    btn.addEventListener('click', async () => {
      if (state.busy) return;
      state.settings = await setSettings({ since: range.id });
      renderWindow();
      // 时间范围变了，数出来的历史条数也要重新数。
      refreshFootprint().catch(() => {});
      refocus('range-opts', range.id);
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
  $('cta-label').textContent = state.busy
    ? `清理中 · ${Math.round(progress.value * 100)}%`
    : label;
  if (!state.busy) $('cta-fill').style.width = '0%';

  const noPage = !state.origin;
  $('btn-clean').disabled =
    state.busy ||
    (s.scope === SCOPE.CURRENT && noPage) ||
    (s.scope === SCOPE.CUSTOM && s.customOrigins.length === 0);

  // 清理进行中把别的控件锁住：中途改范围或改时间，
  // 进度圆环会被冲掉，最后显示的数字也会跟这次清理对不上。
  document.querySelectorAll('.scope button, .window-opt, .toggle, .custom .pill button').forEach((btn) => {
    btn.disabled = state.busy;
  });
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
  renderToggles();
  renderSubject();
  updateCta();
  // 范围换了，统计的是另一批东西，重新数一遍。
  refreshFootprint().catch(() => {});
});

$('btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('btn-reset').addEventListener('click', async () => {
  state.settings = await setSettings({
    scope: SCOPE.ALL,
    items: { cache: true, siteData: true, cookies: false, history: true },
    since: 'all',
  });
  renderScope();
  renderToggles();
  renderWindow();
  renderSubject();
  updateCta();
});

$('btn-clean').addEventListener('click', () => {
  handleClean().catch((err) => {
    console.error(err);
    // 异常路径也要停掉动画：不然圆环会永远停在「99% 清理中」并一直占着 CPU。
    stopProgress();
    state.busy = false;
    $('btn-clean').classList.remove('is-busy');
    updateCta();
    announce('清理失败');
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

  // 没有可清理的来源时主按钮本来就是禁用的，这里只是兜底。
  if (scope !== SCOPE.ALL && origins.length === 0) return;

  // 当前站点在「保留登录状态」名单里不是错误：缓存和历史照清，
  // 只有 Cookie 和站点数据会被保住，所以不在这里拦下。

  // 主按钮只清浏览器本地的数据——不碰账号里的东西。

  // 这里不二次确认：这个扩展存在的意义就是「一下就清掉」，
  // 每次都弹窗等于把它变成 Chrome 自己的设置页。想控制范围，用上面的范围和时间范围。

  state.busy = true;
  // 勾了几项就分几格，圆环按这个分数走。
  startProgress(ITEM_DEFS.filter((d) => s.items[d.key]).length);
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
    // 当前标签页的来源要一并算进保留名单的展开，否则正在看的那个子域保不住。
    currentOrigin: state.origin || '',
    onProgress: (step, index, total) => {
      advanceProgress(step, index, total);
    },
  });

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

  // 等收尾动画走完，按钮再变回可点的样子。
  // scope 用这次清理开始时捕获的那份——中途改了范围的话，
  // 拿现在的范围来渲染结果，会显示成「清了另一个范围」。
  await showResult(report, freed, scope);
  state.busy = false;
  $('btn-clean').classList.remove('is-busy');
  updateCta();

  // 数据变了，重新数一遍。面板此刻正显示「已清空」，所以只更新数据，不重绘。
  if (scope !== SCOPE.CURRENT) {
    state.footprint = await measureFootprint({
      scope,
      origins,
      since: TIME_RANGE_MAP[s.since] ? TIME_RANGE_MAP[s.since].ms : 0,
      keepLogin: s.keepLogin,
    });
  }

  await pushCleanHistory({
    scope,
    freed,
    historyRemoved: report.historyRemoved,
    durationMs: report.durationMs,
    items: report.items.map((i) => i.key),
  });
  await renderFooter();
}

/* ---------------------------------------------------------------- 进度 */

/**
 * 清理的时候，圆环从「数据构成」切成「进度盘」：中心走百分比，弧按比例涨，
 * 按钮里同时有一道填充在推进。
 *
 * 百分比按步骤推进：勾了几项就分几格，每一步占一格。
 * 没真正做完之前最多报 99%，所以它不会谎报已经清完了。
 */
const progress = {
  raf: null,
  value: 0, // 当前显示的比例
  target: 0, // 正在追的比例
  total: 1,
  last: 0,
  startedAt: 0,
  done: false,
  runningKey: '',
};

const EASE_MS = 180; // 追一个目标所用的时间常数
const MIN_SWEEP_MS = 600; // 清理再快，这一圈也得让人看见走完
let progressArc = null;

function startProgress(total) {
  progress.total = Math.max(1, total);
  progress.value = 0;
  progress.target = 0;
  progress.done = false;
  progress.startedAt = performance.now();
  progress.last = progress.startedAt;
  progress.runningKey = '';

  // 非当前范围平时是收起足迹计的，清理时亮出来，进度才有地方显示。
  $('meter').hidden = false;
  $('subject-note').hidden = true;

  renderStepLegend();
  paintProgress();
  if (!progress.raf) progress.raf = requestAnimationFrame(tickProgress);
}

function advanceProgress(step, index, total) {
  progress.total = Math.max(1, total);
  progress.target = Math.min(1, index / total);
  // 上一项到这里才算真的做完。
  if (progress.runningKey) {
    markStepState(progress.runningKey, 'done');
    markToggleDone(progress.runningKey);
  }
  progress.runningKey = step;
  markStepState(step, 'running');
}

function tickProgress(now) {
  const dt = Math.min(64, now - progress.last);
  progress.last = now;
  const diff = progress.target - progress.value;
  if (diff > 0) {
    progress.value += diff * Math.min(1, dt / EASE_MS);
  }
  paintProgress();
  progress.raf = requestAnimationFrame(tickProgress);
}

function paintProgress() {
  // 没真正做完之前不报 100%，不然最后一步还在跑却已经满格了。
  const ratio = progress.done ? progress.value : Math.min(0.99, progress.value);
  const pct = Math.round(ratio * 100);
  renderProgressRing(ratio);
  $('core-value').textContent = `${pct}%`;
  $('core-label').textContent = '清理中';
  if (!state.busy) return;
  $('cta-fill').style.width = `${pct}%`;
  $('cta-label').textContent = `清理中 · ${pct}%`;
}

/** 圆环切成进度盘：一条信号色圆弧，从十二点方向顺时针涨 */
function renderProgressRing(ratio) {
  const g = $('ring-segments');
  if (!progressArc || !progressArc.isConnected) {
    g.textContent = '';
    progressArc = document.createElementNS(SVG_NS, 'circle');
    progressArc.setAttribute('cx', '50');
    progressArc.setAttribute('cy', '50');
    progressArc.setAttribute('r', String(RING_R));
    progressArc.setAttribute('class', 'ring-seg');
    progressArc.setAttribute('stroke', 'var(--signal)');
    progressArc.style.strokeLinecap = 'round';
    g.appendChild(progressArc);
  }

  if (ratio <= 0) {
    progressArc.style.opacity = '0';
    return;
  }
  progressArc.style.opacity = '1';
  const len = ratio >= 1 ? RING_C : Math.max(1, ratio * RING_C - RING_GAP);
  progressArc.style.strokeDasharray = `${len} ${RING_C}`;
}

/** 清理中的图例：列出这次要清的几项 */
function renderStepLegend() {
  const items = ITEM_DEFS.filter((d) => state.settings.items[d.key]).map((d) => ({
    key: d.key,
    label: d.label,
    value: '待清理',
    state: 'pending',
  }));
  if (!items.length) items.push({ key: 'none', label: '没有勾选任何清理项', value: '' });
  renderLegend(items);
}

function markStepState(key, status) {
  const li = document.querySelector(`#legend li[data-key="${key}"]`);
  if (!li) return;
  li.classList.remove('is-pending', 'is-running', 'is-done');
  li.classList.add(`is-${status}`);
  const value = li.querySelector('.val');
  if (!value) return;
  if (status === 'running') value.textContent = '清理中…';
  else if (status === 'done') value.textContent = '已清除';
}

function stopProgress() {
  if (progress.raf) cancelAnimationFrame(progress.raf);
  progress.raf = null;
}

/** 收尾：把剩下的那段补满，停一下，再变成 ✓ */
function finishProgress() {
  if (progress.runningKey) markToggleDone(progress.runningKey);

  // 数据其实早就删完了，但圈得让人看见走完这一圈——
  // 真实清理往往只要一百多毫秒，不撑一下这一圈根本看不见。
  // 这段时间里进度条继续跑，只是不会报 100%。
  const elapsed = performance.now() - progress.startedAt;
  const wait = Math.max(0, MIN_SWEEP_MS - elapsed);

  return new Promise((resolve) => {
    setTimeout(() => {
      stopProgress();
      progress.done = true;

      const from = progress.value;
      const start = performance.now();
      const fill = (now) => {
        const t = Math.min(1, (now - start) / 260);
        progress.value = from + (1 - from) * t;
        paintProgress();
        if (t < 1) {
          requestAnimationFrame(fill);
          return;
        }
        setTimeout(() => {
          if (progressArc) progressArc.style.opacity = '0';
          $('ring-core').classList.add('is-empty');
          $('core-value').textContent = '✓';
          $('core-label').textContent = '已清空';
          resolve();
        }, 260);
      };
      requestAnimationFrame(fill);
    }, wait);
  });
}

function markToggleDone(step) {
  const btn = document.querySelector(`.toggle[data-key="${step}"]`);
  if (btn) btn.classList.add('is-done');
}

/** 播报一句给屏幕阅读器。进度百分比不播报——每秒变一次会吵到人。 */
function announce(text) {
  $('live-status').textContent = text;
}

/** 清理完成后，图例换成逐项结果，圆环走满再变成 ✓ */
function showResult(report, freed, scope) {
  const current = scope === SCOPE.CURRENT;

  // 失败要带原因，不能只写「失败」两个字——
  // 浏览器返回的原始错误才是用户（和排障的人）看得懂的东西。
  const reasonFor = (key) => {
    const line = report.errors.find((e) => e.startsWith(`${key}:`));
    if (!line) return '失败';
    const msg = line.slice(key.length + 1).trim();
    return msg ? `失败：${msg}` : '失败';
  };

  const rows = report.items.map((item) => ({
    key: item.key,
    label: item.label,
    value:
      item.status === 'error'
        ? reasonFor(item.key)
        : item.status === 'skipped'
          ? item.note || '已跳过'
          : item.note || '已清除',
    state:
      item.status === 'error' ? 'fail' : item.status === 'skipped' ? 'skip' : 'done',
  }));

  if (!rows.length) {
    rows.push({ key: 'none', label: '没有勾选任何清理项', value: '' });
  }

  const meta = [];
  if (freed) meta.push(`释放 ${formatBytes(freed)}`);
  meta.push(`用时 ${formatDuration(report.durationMs)}`);

  const done = report.items.filter((i) => i.status === 'done').length;
  const failed = report.items.filter((i) => i.status === 'error').length;

  // 圆环走完这一圈，再把图例换成逐项结果——
  // 放在动画之后，才不会被「正在清理」的步骤状态覆盖掉具体数字。
  return finishProgress().then(() => {
    renderLegend(rows);
    $('meter').hidden = false;

    if (current) {
      $('subject-note').hidden = true;
      $('site-size').textContent = meta.join(' · ');
    } else {
      $('subject-note').hidden = false;
      $('subject-note').innerHTML = `<b>${done} 项已清除</b><br>${meta.join(' · ')}`;
    }

    announce(failed ? `${done} 项已清除，${failed} 项失败` : `${done} 项已清除，${meta.join('，')}`);
  });
}
