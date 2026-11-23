import { ITEM_MAP } from './constants.js';
import { hostOf, registrableDomain } from './util.js';

/**
 * originTypes 只包含普通网页来源，排除扩展自身的存储，
 * 避免「清理全部网站」时把别的扩展的数据也抹掉。
 */
const WEB_ORIGIN_TYPES = { unprotectedWeb: true, protectedWeb: true, extension: false };

function toDataTypeSet(keys) {
  const set = {};
  for (const key of keys) {
    for (const type of ITEM_MAP[key].types) set[type] = true;
  }
  return set;
}

function resultRow(key, status, note) {
  return { key, label: ITEM_MAP[key].label, status, note: note || '' };
}

/** 当前站点在这个范围内的 Cookie 数量（仅用于给用户一个预期） */
export async function countCookies(origin) {
  try {
    const cookies = await chrome.cookies.getAll({ url: origin });
    return cookies.length;
  } catch {
    return null;
  }
}

/** 清理某几个来源的浏览历史。browsingData 的 origins 不作用于 history，只能逐条删。 */
async function clearHistoryForOrigins(origins, since) {
  let removed = 0;
  for (const origin of origins) {
    const host = hostOf(origin);
    if (!host) continue;

    const candidates = new Set();
    // 先用完整主机名搜，命中不够再退到可注册域；两次结果都按主机名过滤，不会误删别的站。
    for (const query of [host, registrableDomain(host)]) {
      if (candidates.size) break;
      let hits = [];
      try {
        hits = await chrome.history.search({ text: query, startTime: since || 0, maxResults: 5000 });
      } catch {
        hits = [];
      }
      for (const item of hits) {
        const h = hostOf(item.url);
        if (h === host || h.endsWith(`.${host}`)) candidates.add(item.url);
      }
    }

    for (const url of candidates) {
      try {
        await chrome.history.deleteUrl({ url });
        removed += 1;
      } catch {}
    }
  }
  return removed;
}

/**
 * 清空浏览历史。deleteRange 不返回数量，只能先数一遍；
 * 搜索有 maxResults 上限，数到上限就说明是近似值，返回 null 而不是给一个假数字。
 */
async function clearAllHistory(since) {
  const startTime = since || 0;
  let count = null;
  try {
    const hits = await chrome.history.search({ text: '', startTime, maxResults: 10000 });
    count = hits.length >= 10000 ? null : hits.length;
  } catch {
    count = null;
  }
  await chrome.history.deleteRange({ startTime, endTime: Date.now() });
  return count;
}

/**
 * 主清理流程。
 *
 * @param {object} opts
 * @param {'current'|'all'|'custom'} opts.scope
 * @param {string[]} opts.origins   scope 为 current/custom 时的目标来源
 * @param {number} opts.since       毫秒时间戳，0 表示不限时间
 * @param {object} opts.items       { cache, siteData, cookies, history } 开关
 * @param {string[]} opts.keepLogin 保留登录状态的域名（清缓存/存储但不动 Cookie）
 * @param {(step:string, index:number, total:number)=>void} opts.onProgress
 */
export async function runClean({
  scope,
  origins = [],
  since = 0,
  items = {},
  keepLogin = [],
  onProgress = () => {},
}) {
  const started = Date.now();
  const report = {
    scope,
    origins: [...origins],
    since,
    items: [],
    historyRemoved: null,
    skipped: [],
    errors: [],
    durationMs: 0,
  };

  const steps = ['cache', 'siteData', 'cookies', 'history'].filter((k) => items[k]);
  const total = steps.length;
  let index = 0;

  // excludeOrigins 对 Cookie 生效于整个可注册域，对存储只匹配精确 origin。
  // 所以两个都要给：否则 mail.google.com 的 LocalStorage 清不掉。
  const keepOrigins = [...new Set(
    keepLogin.flatMap((h) => {
      const host = h.includes('://') ? hostOf(h) : h;
      return [`https://${host}`, `https://${registrableDomain(host)}`];
    }),
  )];

  const isKept = (origin) => {
    if (!keepOrigins.length) return false;
    const host = hostOf(origin);
    return keepOrigins.includes(`https://${host}`) || keepOrigins.includes(`https://${registrableDomain(host)}`);
  };

  const run = async (key, dataTypes, options) => {
    index += 1;
    onProgress(key, index, total);
    try {
      await chrome.browsingData.remove(options, dataTypes);
      report.items.push(resultRow(key, 'done', ''));
    } catch (e) {
      report.errors.push(`${key}: ${e && e.message ? e.message : e}`);
      report.items.push(resultRow(key, 'error', '失败'));
    }
  };

  try {
    if (scope === 'all') {
      const base = { since, originTypes: WEB_ORIGIN_TYPES };
      // 保留登录的站点整体排除：清掉 localStorage/IndexedDB 同样会把人踢下线。
      const excluded = keepOrigins.length ? { excludeOrigins: keepOrigins } : {};

      if (items.cache) await run('cache', toDataTypeSet(['cache']), { ...base, ...excluded });
      if (items.siteData) await run('siteData', toDataTypeSet(['siteData']), { ...base, ...excluded });
      if (items.cookies) await run('cookies', toDataTypeSet(['cookies']), { ...base, ...excluded });
    } else {
      // 单站点范围下，命中白名单的来源直接跳过，避免清掉别人的登录态。
      const targets = origins.filter((origin) => !isKept(origin));
      report.skipped = origins.filter((o) => isKept(o));

      if (targets.length) {
        const options = { origins: targets, since };
        if (items.cache) await run('cache', toDataTypeSet(['cache']), options);
        if (items.siteData) await run('siteData', toDataTypeSet(['siteData']), options);
        if (items.cookies) await run('cookies', toDataTypeSet(['cookies']), options);
      }
    }

    if (items.history) {
      index += 1;
      onProgress('history', index, total);
      try {
        const historyTargets = scope === 'all' ? null : origins.filter((origin) => !isKept(origin));

        if (historyTargets && historyTargets.length === 0) {
          report.items.push(resultRow('history', 'skipped', '已跳过'));
        } else {
          report.historyRemoved =
            scope === 'all' ? await clearAllHistory(since) : await clearHistoryForOrigins(historyTargets, since);
          report.items.push(
            resultRow(
              'history',
              'done',
              report.historyRemoved === null ? '已清除' : `${report.historyRemoved} 条`,
            ),
          );
        }
      } catch (e) {
        report.errors.push(`history: ${e && e.message ? e.message : e}`);
        report.items.push(resultRow('history', 'error', '失败'));
      }
    }
  } catch (e) {
    report.errors.push(String(e));
  }

  report.durationMs = Date.now() - started;
  return report;
}
