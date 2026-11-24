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
async function clearHistoryForOrigins(origins, startTime) {
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
        hits = await chrome.history.search({ text: query, startTime, maxResults: 5000 });
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
async function clearAllHistory(startTime) {
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
 * @param {string[]} opts.keepLogin 保留登录状态的域名（不动 Cookie 和本地存储，缓存与历史照清）
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

  // since 是「往前多久」（毫秒时长），但 chrome.browsingData 的 since 和
  // chrome.history 的 startTime 要的都是「绝对时间戳」。这里换算一次，
  // 全流程用同一个时间点——不然两次 now() 差几毫秒，边界就对不上了。
  // （传错的话，选「24 小时」会变成删掉 1970 年以来的全部数据。）
  const cutoff = since ? Date.now() - since : 0;

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

  // 跳过的步骤也要报到进度里，否则进度条会停在半路。
  const skip = (key, note) => {
    index += 1;
    onProgress(key, index, total);
    report.items.push(resultRow(key, 'skipped', note));
  };

  try {
    if (scope === 'all') {
      const base = { since: cutoff, originTypes: WEB_ORIGIN_TYPES };
      // 名单里的站只保 Cookie 和本地存储——那才是登录态所在。
      // 缓存和历史跟登录无关，照清；否则「保留登录」会顺带把缓存也留下。
      const excluded = keepOrigins.length ? { excludeOrigins: keepOrigins } : {};

      if (items.cache) await run('cache', toDataTypeSet(['cache']), base);
      if (items.siteData) await run('siteData', toDataTypeSet(['siteData']), { ...base, ...excluded });
      if (items.cookies) await run('cookies', toDataTypeSet(['cookies']), { ...base, ...excluded });
    } else {
      // 命中名单的来源照清缓存，但不动它的 Cookie 和站点数据。
      const targets = origins.filter((origin) => !isKept(origin));
      report.skipped = origins.filter((origin) => isKept(origin));

      if (origins.length) {
        const every = { origins, since: cutoff };
        const unprotected = { origins: targets, since: cutoff };
        if (items.cache) await run('cache', toDataTypeSet(['cache']), every);
        if (items.siteData) {
          if (targets.length) await run('siteData', toDataTypeSet(['siteData']), unprotected);
          else skip('siteData', '已保留');
        }
        if (items.cookies) {
          if (targets.length) await run('cookies', toDataTypeSet(['cookies']), unprotected);
          else skip('cookies', '已保留');
        }
      }
    }

    if (items.history) {
      index += 1;
      onProgress('history', index, total);
      try {
        // 历史跟登录无关，名单里的站也照清——和「全部网站」范围保持同一个口径。
        const historyTargets = scope === 'all' ? null : origins;

        if (historyTargets && historyTargets.length === 0) {
          report.items.push(resultRow('history', 'skipped', '已跳过'));
        } else {
          report.historyRemoved =
            scope === 'all' ? await clearAllHistory(cutoff) : await clearHistoryForOrigins(historyTargets, cutoff);
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
