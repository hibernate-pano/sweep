import { claudePage, chatgptPage } from './pageScripts.js';
import { hostOf } from './util.js';

/**
 * 已知聊天平台。fn 必须在目标页面上下文里执行，用的是用户自己的登录态。
 * 新增平台只需在这里加一条：给出 id / label / hosts / fn 即可。
 */
export const CHAT_SITES = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    fn: chatgptPage,
  },
  {
    id: 'claude',
    label: 'Claude',
    hosts: ['claude.ai', 'claude.com'],
    fn: claudePage,
  },
];

export function matchChatSite(url) {
  const host = hostOf(url);
  if (!host) return null;
  return (
    CHAT_SITES.find((site) => site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || null
  );
}

async function runInPage(tabId, fn, mode) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: fn,
      args: [mode],
    });
    return results && results[0] ? results[0].result : null;
  } catch (e) {
    return null;
  }
}

/** 只读：云端有多少条会话 */
export async function probeCloud(tabId, site) {
  if (!tabId || !site) return null;
  const result = await runInPage(tabId, site.fn, 'list');
  if (!result || !result.ok) return null;
  return { total: result.total || 0, error: null };
}

/** 写：逐条删除云端会话 */
export async function deleteCloud(tabId, site) {
  if (!tabId || !site) return null;
  const result = await runInPage(tabId, site.fn, 'delete');
  if (!result) return { ok: false, deleted: 0, error: 'inject-failed' };
  return { ok: Boolean(result.ok), deleted: result.deleted || 0, error: result.error || null };
}
