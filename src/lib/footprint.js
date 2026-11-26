import { hostOf, registrableDomain } from './util.js';

/**
 * 全局足迹统计。
 *
 * 一个诚实的限制：扩展没有读取「整个浏览器缓存占多少字节」的接口。
 * 能数出来的只有三样——历史条数、Cookie 条数、涉及多少个网站。
 * 与其编一个假的体积数字，不如把这三样真数出来。
 */

/** 一次最多取多少条历史。超过就只能报「至少」，不能假装精确。 */
const HISTORY_LIMIT = 10000;

/** Cookie 的 domain 可能是 '.example.com'，去掉前导点。 */
function cookieHost(domain) {
  return String(domain || '').replace(/^\./, '').toLowerCase();
}

/** 历史的 host 是否属于这个 origin：它本身，或者它的子域。 */
function hostInOrigin(host, originHost) {
  if (!host || !originHost) return false;
  return host === originHost || host.endsWith(`.${originHost}`);
}

/** 这个 Cookie 会不会作用到这个 origin：域相同，或 Cookie 的域是 origin 的父域。 */
function cookieInOrigin(cHost, originHost) {
  if (!cHost || !originHost) return false;
  return cHost === originHost || originHost.endsWith(`.${cHost}`);
}

/** 保留名单里的 Cookie 不会被删（名单按主域名生效，和清理逻辑同一口径）。 */
function cookieKept(cHost, keepHosts) {
  return keepHosts.some((host) => {
    if (!host) return false;
    return cHost === host || cHost === registrableDomain(host) || host.endsWith(`.${cHost}`);
  });
}

function normalizeHost(h) {
  const raw = String(h || '');
  return hostOf(raw.includes('://') ? raw : `https://${raw}`);
}

/**
 * 统计当前范围里有多少足迹。
 *
 * @param {object} opts
 * @param {'all'|'custom'} opts.scope
 * @param {string[]} opts.origins     scope 为 custom 时的目标来源
 * @param {number}   opts.since       毫秒时间戳，0 表示不限时间（只作用于历史）
 * @param {string[]} opts.keepLogin   保留登录状态的域名
 */
export async function measureFootprint({ scope, origins = [], since = 0, keepLogin = [] }) {
  const keepHosts = keepLogin.map(normalizeHost).filter(Boolean);
  const originHosts = origins.map((o) => hostOf(o)).filter(Boolean);

  let items = [];
  let capped = false;
  try {
    // since 是「往前多久」，history.search 的 startTime 要的是绝对时间戳。
    // text 是必填的（留空串 = 取全部记录），漏了会让整个调用被浏览器拒绝。
    const startTime = since ? Date.now() - since : 0;
    items = await chrome.history.search({ text: '', startTime, maxResults: HISTORY_LIMIT });
    capped = items.length >= HISTORY_LIMIT;
  } catch {
    items = [];
  }

  let cookies = [];
  try {
    cookies = await chrome.cookies.getAll({});
  } catch {
    cookies = [];
  }

  const historyItems =
    scope === 'all'
      ? items
      : items.filter((it) => originHosts.some((h) => hostInOrigin(hostOf(it.url), h)));

  const cookieCount = cookies.filter((c) => {
    const h = cookieHost(c.domain);
    const inScope = scope === 'all' ? true : originHosts.some((oh) => cookieInOrigin(h, oh));
    if (!inScope) return false;
    return !cookieKept(h, keepHosts);
  }).length;

  const siteCount =
    scope === 'all'
      ? new Set(historyItems.map((it) => registrableDomain(hostOf(it.url))).filter(Boolean)).size
      : originHosts.length;

  return {
    history: { count: historyItems.length, capped },
    cookies: { count: cookieCount, capped: false },
    sites: { count: siteCount, capped },
    total: historyItems.length + cookieCount + siteCount,
  };
}
