#!/usr/bin/env node
/**
 * Chrome Web Store 发布 CLI（通用版，与具体项目无关）。
 *
 * 子命令：
 *   status              查草稿（crxVersion / uploadState）
 *   upload <zip>        上传新包（更新草稿）
 *   publish <version>   提交审核（**版本必填** —— 见下）
 *   verify <version>    再 publish 一次并解读商店的答复（自证「确实进了审核队列」）
 *   live                抓公开页的当前版本（**线上是哪个版本只认这个**）
 *
 * 通用参数：
 *   --item-id <id|url>  商店 item id（也接受详情页 URL，自动取最后一段）
 *   --creds <file.json> 凭据 JSON（默认 ~/.config/mcp/mcp.json）
 *   --proxy <url>       代理（默认取环境里的 HTTPS_PROXY）
 *   --retries <n>       网络层重试次数（默认 3，间隔 2 秒）
 *
 * ── 为什么这里的每一条判据都写成「fail-closed」────────────────────────────
 *
 * Chrome 商店的 API 有三处**「HTTP 200 但事情没成」**的形状，历史上都被它骗过：
 *
 *   ① upload 回 HTTP 200 + `uploadState: FAILURE` + `itemError[ITEM_NOT_UPDATABLE]`
 *      （item 在审核队列时就是这个形状）⇒ 只看 HTTP 码会把「没发上去」报成「上传成功」。
 *   ② publish 回 HTTP 200 + `{"status":["OK"]}`，但**草稿是空的** ⇒ 静默 no-op，
 *      线上什么也没变。
 *   ③ item 资源上的 `uploadState` **不表示「草稿里有没有包」**：
 *      上传成功之后它也是 NOT_FOUND，空草稿时也是 NOT_FOUND ⇒ 拿它当发布闸门
 *      会把**真发布拦下来**。
 * ⇒ 所以：upload 看**回包里的 uploadState**；publish 前看**草稿的 crxVersion**，
 *   publish 后看**回包里的 status**；线上版本**只认公开页**。
 *
 * ── 为什么用 curl 子进程而不是 fetch ─────────────────────────────────────
 * 本机出境走 Clash 代理最稳：curl 原生认 HTTPS_PROXY；
 * Node 22 的 fetch 要开 NODE_USE_ENV_PROXY（实验特性）。
 * 另：上传 zip 必须用 `curl -T <file>`（文件模式）——
 * 用 --data-binary / JS 的 body 传会经过 Buffer→字符串转换，**zip 字节被破坏**，
 * 服务端返回一堆莫名其妙的 404。
 *
 * 用法示例：
 *   export HTTPS_PROXY=http://127.0.0.1:7897
 *   node cws-release.mjs status  --item-id bbbpnccbclnnphchghpfmcjjfhigepbk
 *   node cws-release.mjs upload  dist/chrome-extension.zip --item-id <id>
 *   node cws-release.mjs publish 1.28.3 --item-id <id>
 *   node cws-release.mjs live    --item-id <id>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const BASE = 'https://www.googleapis.com/chromewebstore/v1.1';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/chromewebstore/v1.1';
const PUBLIC_PAGE = 'https://chromewebstore.google.com/detail';
const RETRY_DELAY_MS = 2000;

// ── 参数解析 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const positional = argv.slice(1).filter((a, i, all) => {
  if (a.startsWith('--')) return false;
  const prev = all[i - 1];
  return !(prev && prev.startsWith('--'));
});

/** item id 可以是裸 id，也可以是详情页 URL（取最后一段）。 */
const normalizeItemId = (raw) => {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s.includes('/')) {
    const seg = s.split('/').filter(Boolean).pop() ?? '';
    return seg.includes('?') ? seg.split('?')[0] : seg;
  }
  return s;
};

const ITEM_ID = normalizeItemId(flag('item-id') || process.env.CWS_ITEM_ID || '');
const CREDS_FILE = resolve(flag('creds', resolve(homedir(), '.config/mcp/mcp.json')));
const PROXY = flag('proxy') || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const RETRIES = Number(flag('retries', '3')) || 3;
if (PROXY) {
  process.env.HTTPS_PROXY = PROXY;
  process.env.HTTP_PROXY = PROXY;
}

// ── 凭据 ───────────────────────────────────────────────────────────────────
/**
 * 读凭据。接受两种形状：
 *   ① 直接是 {CWS_CLIENT_ID:…, CWS_CLIENT_SECRET:…, CWS_REFRESH_TOKEN:…}
 *   ② MCP 配置 {mcpServers:{"cws-mcp":{env:{…}}}}
 * 值的形态可能是 `{{SECRET_xxxx}}<真值>`（有些 secret 管理器写盘时会带占位符前缀）
 * ⇒ 统一剥掉前缀，否则换 token 直接失败，而报错看着像「凭证不对」。
 */
function readCreds() {
  const fromEnv = {
    CWS_CLIENT_ID: process.env.CWS_CLIENT_ID,
    CWS_CLIENT_SECRET: process.env.CWS_CLIENT_SECRET,
    CWS_REFRESH_TOKEN: process.env.CWS_REFRESH_TOKEN,
  };
  if (fromEnv.CWS_CLIENT_ID && fromEnv.CWS_CLIENT_SECRET && fromEnv.CWS_REFRESH_TOKEN) {
    return fromEnv;
  }
  if (!existsSync(CREDS_FILE)) {
    console.error(`缺少凭据：环境变量里没有 CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN，`
      + `也没找到 ${CREDS_FILE}`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
  const env =
    raw?.mcpServers?.['cws-mcp']?.env ||
    raw?.env ||
    raw?.mcpServers?.['chrome-web-store']?.env ||
    raw;
  const strip = (v) => String(v ?? '').replace(/^\{\{[A-Za-z0-9_]+\}\}/, '');
  const out = {
    CWS_CLIENT_ID: strip(env.CWS_CLIENT_ID),
    CWS_CLIENT_SECRET: strip(env.CWS_CLIENT_SECRET),
    CWS_REFRESH_TOKEN: strip(env.CWS_REFRESH_TOKEN),
  };
  for (const [k, v] of Object.entries(out)) {
    if (!v) {
      console.error(`缺少凭据 ${k}（环境变量与 ${CREDS_FILE} 都没有）`);
      process.exit(2);
    }
  }
  return out;
}

// ── HTTP（走 curl 子进程）──────────────────────────────────────────────────
/** curl 调 API。返回 { status, body, ok }；网络层失败时 status=0。 */
function http(method, url, { headers = [], body, follow = false } = {}) {
  const args = ['-sS'];
  // 公开页会 301（/detail/<id> → /detail/<slug>/<id>）⇒ 抓公开页要跟跳转。
  if (follow) args.push('-L');
  args.push('-X', method);
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body) args.push('--data-binary', body);
  args.push(url, '-w', '\n%{http_code}');
  try {
    const out = execFileSync('curl', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const nl = out.lastIndexOf('\n');
    return { status: Number(out.slice(nl + 1).trim()), body: out.slice(0, nl), ok: true };
  } catch (err) {
    const e = err;
    // curl 自己失败（SSL 断、超时、DNS 失败）⇒ stdout 里通常只有「000」
    const out = e.stdout ?? '';
    const nl = out.lastIndexOf('\n');
    const status = nl >= 0 ? Number(out.slice(nl + 1).trim()) : 0;
    return {
      status: Number.isFinite(status) ? status : 0,
      body: nl >= 0 ? out.slice(0, nl) : out,
      ok: false,
      error: (e.stderr ?? '').trim(),
    };
  }
}

/** 公开页抓取（走 curl，好处是自动认代理；跟 301 跳转）。 */
function fetchPage(url) {
  return http('GET', url, { follow: true });
}

/**
 * 网络层重试。
 *
 * 只重试「网络失败」（curl 退出码非 0 / status=0 / 5xx）——
 * 商店给出的 4xx 是**答案**，不是故障，重试没有意义。
 * 代理不稳时最典型的症状就是 `curl: (35) SSL_ERROR_SYSCALL` ⇒ 重试 3~4 次就好了。
 */
function withRetry(label, fn) {
  let last;
  for (let i = 1; i <= RETRIES; i++) {
    last = fn();
    const networkBroken = !last.ok || last.status === 0 || last.status >= 500;
    if (!networkBroken) return last;
    if (i < RETRIES) {
      console.warn(`⚠️  ${label} 第 ${i} 次尝试失败（${last.status || '网络错误'}）`
        + `${last.error ? '：' + last.error.split('\n')[0] : ''} —— ${RETRY_DELAY_MS / 1000}s 后重试`);
      execFileSync('sleep', [String(RETRY_DELAY_MS / 1000)]);
    }
  }
  return last;
}

function parseJsonSafe(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

let token = null;
function accessToken() {
  if (token) return token;
  const creds = readCreds();
  const res = withRetry('换 access token', () =>
    http('POST', 'https://oauth2.googleapis.com/token', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.CWS_CLIENT_ID,
        client_secret: creds.CWS_CLIENT_SECRET,
        refresh_token: creds.CWS_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }).toString(),
    }),
  );
  const json = parseJsonSafe(res.body);
  if (!json?.access_token) {
    console.error(`换 access token 失败（HTTP ${res.status}）：${res.body.slice(0, 300)}`);
    console.error('  · 代理没通？⇒ 先确认代理端口在监听，再重试');
    console.error('  · 凭据不对？⇒ 凭据文件里可能带 {{SECRET_…}} 占位符前缀（脚本已剥，但值本身可能已过期）');
    process.exit(2);
  }
  token = json.access_token;
  return token;
}

const auth = () => ({ Authorization: `Bearer ${accessToken()}` });

/** 读草稿。item 资源只有 DRAFT 投影（DRAFT 是唯一合法的 projection 值）。 */
function getItem() {
  return withRetry('读草稿', () =>
    http('GET', `${BASE}/items/${ITEM_ID}?projection=DRAFT`, { headers: auth() }),
  );
}

/** itemError 数组 → 人话（商店只在 itemError 里说「为什么失败」）。 */
function describeItemError(item) {
  const errs = Array.isArray(item?.itemError) ? item.itemError : [];
  if (errs.length === 0) return '';
  return (
    '\n商店给的原因：\n' +
    errs
      .map((e) => `  · ${e?.error_code ?? '(无代码)'}${e?.error_detail ? '：' + e.error_detail : ''}`)
      .join('\n')
  );
}

/** 从 zip 里读 manifest 版本（发行前自证的第一环）。读不到就说读不到，不假装。 */
function readVersionFromZip(zipPath) {
  try {
    const out = execFileSync('unzip', ['-p', zipPath, 'manifest.json'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseJsonSafe(out)?.version ?? null;
  } catch {
    return null;
  }
}

// ── 子命令 ─────────────────────────────────────────────────────────────────
const USAGE = `用法：
  cws-release.mjs status
  cws-release.mjs upload <zip>
  cws-release.mjs publish <version>
  cws-release.mjs verify <version>
  cws-release.mjs live

参数：
  --item-id <id|url>   商店 item id（也接受详情页 URL）
  --creds <file.json>  凭据文件（默认 ~/.config/mcp/mcp.json）
  --proxy <url>        代理（默认取环境里的 HTTPS_PROXY）
  --retries <n>        网络重试次数（默认 3）`;

if (!['status', 'upload', 'publish', 'verify', 'live'].includes(cmd)) {
  console.error(USAGE);
  process.exit(2);
}
if (!ITEM_ID) {
  console.error('缺少 item id（--item-id <id|url> 或 CWS_ITEM_ID env）');
  process.exit(2);
}

if (cmd === 'status') {
  const res = getItem();
  if (res.status < 200 || res.status >= 300) {
    console.error(`查询失败（HTTP ${res.status}）—— 拿不到草稿状态，绝不当作「状态正常」。`);
    console.error(res.body.slice(0, 400));
    process.exit(1);
  }
  const item = parseJsonSafe(res.body);
  console.log(`草稿：crxVersion=${item?.crxVersion ?? '(未知)'}  uploadState=${item?.uploadState ?? '(未知)'}`);
  console.log('  ℹ️ item 上的 uploadState 不表示「草稿里有没有包」（上传成功后它也是 NOT_FOUND）');
  console.log('     ⇒ 判断草稿里有没有包，要看 crxVersion 有没有变成新版本。');
  process.exit(0);
}

if (cmd === 'upload') {
  const zipPath = positional[0];
  if (!zipPath || !zipPath.endsWith('.zip')) {
    console.error('用法：cws-release.mjs upload <zip>');
    process.exit(2);
  }
  if (!existsSync(zipPath) || !statSync(zipPath).isFile()) {
    console.error(`找不到 zip：${zipPath}`);
    process.exit(2);
  }
  const zipVersion = readVersionFromZip(zipPath);
  console.log(zipVersion ? `待上传 zip 的 manifest 版本：${zipVersion}` : '⚠️ 读不到 zip 里的 manifest.json 版本（继续上传，但这次没有版本自证）');

  // 文件直传：-T 必须放在 URL 之前（curl 按 URL 分组选项，-T 放后面会 PUT 无源 ⇒ 404）
  const res = withRetry('上传', () => {
    const args = ['-sS', '-X', 'PUT', '-T', zipPath, '-H', `Authorization: Bearer ${accessToken()}`, '-H', 'Content-Type: application/zip', `${UPLOAD_BASE}/items/${ITEM_ID}`, '-w', '\n%{http_code}'];
    try {
      const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
      const nl = out.lastIndexOf('\n');
      return { status: Number(out.slice(nl + 1).trim()), body: out.slice(0, nl), ok: true };
    } catch (err) {
      const e = err;
      const out = e.stdout ?? '';
      const nl = out.lastIndexOf('\n');
      return { status: nl >= 0 ? Number(out.slice(nl + 1).trim()) : 0, body: nl >= 0 ? out.slice(0, nl) : out, ok: false, error: (e.stderr ?? '').trim() };
    }
  });

  if (res.status < 200 || res.status >= 300) {
    console.error(`上传失败（HTTP ${res.status}）—— 草稿未更新，绝不 publish。`);
    console.error(res.body.slice(0, 400));
    process.exit(1);
  }
  // 三态判据：SUCCESS / FAILURE|NOT_FOUND / IN_PROGRESS / 字段缺失
  let item = parseJsonSafe(res.body);
  let state = item?.uploadState;
  if (state === 'IN_PROGRESS') {
    console.log('商店说上传仍在处理中（IN_PROGRESS），等待落定…');
    for (let i = 0; i < 5; i++) {
      execFileSync('sleep', ['2']);
      const it = parseJsonSafe(getItem().body);
      if (it?.uploadState && it.uploadState !== 'IN_PROGRESS') {
        state = it.uploadState;
        item = it;
        break;
      }
    }
  }
  if (state === 'SUCCESS') {
    console.log(`✓ 上传成功${zipVersion ? `（${zipVersion}）` : ''}`);
    console.log('  下一步：确认草稿 crxVersion 变成这一版，再 publish <版本>');
    process.exit(0);
  }
  if (state === 'FAILURE' || state === 'NOT_FOUND') {
    console.error(`上传失败（uploadState=${state}）—— 草稿未更新，绝不 publish。${describeItemError(item)}`);
    process.exit(1);
  }
  console.error('上传返回 2xx，但回包里没有可判定的 uploadState —— 无法自证是否生效，绝不当作成功。');
  process.exit(1);
}

if (cmd === 'publish' || cmd === 'verify') {
  const expectedVersion = positional[0];
  if (!expectedVersion) {
    console.error('必须给出「期望发布的版本」：cws-release.mjs publish <版本>');
    console.error('  不知道要发哪一版就不许发（草稿里可能是上一版，也可能是空草稿）。');
    process.exit(1);
  }

  // 发布前自检：草稿里的版本必须正是要发的那一版
  const pre = getItem();
  if (pre.status < 200 || pre.status >= 300) {
    console.error(`发布前自检失败（HTTP ${pre.status}）—— 拿不到草稿状态，绝不 publish。`);
    console.error(pre.status === 404 ? '  · 404 通常是 item id 填错了' : '');
    console.error(pre.body.slice(0, 300));
    process.exit(1);
  }
  const preItem = parseJsonSafe(pre.body);
  if (preItem?.uploadState === 'FAILURE') {
    console.error('发布前自检失败：草稿上一次上传是 FAILURE —— 草稿里没有可发的包，绝不 publish。' + describeItemError(preItem));
    process.exit(1);
  }
  if (preItem?.uploadState === 'IN_PROGRESS') {
    console.error('发布前自检失败：商店还在处理上一次上传（IN_PROGRESS）—— 等它落定再 publish。');
    process.exit(1);
  }
  if (preItem?.crxVersion !== expectedVersion) {
    console.error(
      `发布前自检失败：草稿版本 crxVersion=${preItem?.crxVersion ?? '(未知)'} ≠ 期望 ${expectedVersion} —— ` +
        '草稿里不是你要发的那一版，绝不 publish。',
    );
    process.exit(1);
  }
  console.log(`发布前自检通过：草稿 crxVersion=${preItem.crxVersion}（期望 ${expectedVersion}）`);

  const res = withRetry('publish', () =>
    http('POST', `${BASE}/items/${ITEM_ID}/publish`, { headers: auth() }),
  );
  if (res.status < 200 || res.status >= 300) {
    const body = res.body ?? '';
    // 「item 在审核队列」= 商店说「有一个版本在审」⇒ 你的 publish 没生效
    // （也可能是**已经生效**了 —— 只看这句话区分不了，要拿公开页/草稿版本一起判断）
    if (/in review|pending review|ITEM_NOT_UPDATABLE|ITEM_PENDING_REVIEW/i.test(body)) {
      console.error(`发布未生效（HTTP ${res.status}）：商店说这个 item 已在审核队列。`);
      console.error('  · 这可能意味着：① 上一版还在审（你的新版本传不上去，等审核放行）；');
      console.error('    ② 或者你**刚才已经提交成功**了（再发一次就被这样拒）。');
      console.error('  · 判别方法：看草稿 crxVersion 是不是你要发的那一版 + 看公开页版本号。');
      console.error(body.slice(0, 300));
      process.exit(3);
    }
    console.error(`提交审核失败（HTTP ${res.status}）—— 草稿仍是草稿，线上没有变化`);
    console.error(body.slice(0, 300));
    process.exit(1);
  }
  const statusMatch = (res.body ?? '').match(/"status"\s*:\s*\[([^\]]*)\]/);
  if (!statusMatch) {
    console.error('publish 返回 2xx，但回包里找不到 status 字段 —— 无法自证提交是否生效，绝不当作已发布。');
    process.exit(1);
  }
  if (!/OK/.test(statusMatch[1])) {
    console.error(`publish 返回 2xx，但 status 里没有 OK（${statusMatch[0]}）—— 提交未生效，线上没有任何变化。`);
    process.exit(1);
  }
  console.log(`✓ 已提交审核（商店回包 status:["OK"]）${cmd === 'verify' ? '' : ''}`);
  console.log('  下一步自证：再跑一次 `verify <版本>` —— 商店回 “in review” 就说明确实进了审核队列；');
  console.log('  再就是等公开页版本号变化（那才是「上架了」）。');
  process.exit(0);
}

if (cmd === 'live') {
  // 公开页偶尔会返回「JS 壳页」（正文里没有版本号）⇒ 多试几次；
  // 真的抓不到就说抓不到，**不猜**。
  const PATTERN = />Version<\/div><div[^>]*>([^<]*)<\/div>/;
  let m = null;
  let u = null;
  for (let i = 1; i <= 3 && !m; i++) {
    const res = withRetry('抓公开页', () => fetchPage(`${PUBLIC_PAGE}/${ITEM_ID}`));
    if (res.status < 200 || res.status >= 300) {
      console.error(`公开页抓取失败（HTTP ${res.status}）—— 拿不到线上版本，不猜。`);
      process.exit(1);
    }
    m = PATTERN.exec(res.body);
    u = m ? />Updated<\/div><div[^>]*>([^<]*)<\/div>/.exec(res.body) : null;
    if (!m && i < 3) {
      console.warn(`⚠️  第 ${i} 次抓到的公开页里没有版本号（可能返回了 JS 壳页）—— 重试`);
      execFileSync('sleep', ['2']);
    }
  }
  if (!m) {
    console.error('公开页里没抓到版本号（页面结构可能变了，或抓到的不是详情页）—— 拿不到就是拿不到，不猜。');
    process.exit(1);
  }
  console.log(`线上版本（公开页）：${m[1]}${u ? `   更新于：${u[1]}` : ''}`);
  console.log('  ℹ️ item API 只有 DRAFT 投影 ⇒ 公开页是「线上是哪个版本」的唯一真相。');
  process.exit(0);
}
