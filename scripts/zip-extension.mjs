#!/usr/bin/env node
/**
 * 把一个扩展的构建产物（dist/）打成 Chrome 商店要的 zip。
 *
 * 用法：
 *   node zip-extension.mjs <distDir> [outZip] [--keep-maps] [--exclude <pattern> ...]
 *
 * 默认 outZip = <distDir>/../<name>-<version>.zip
 *
 * ── 三条最容易翻车的规则（这里都替你守住了）──────────────────────────────
 *
 * ① **zip 的根目录必须就是 manifest.json**。
 *    多套一层目录（`my-ext/manifest.json`）⇒ 商店报「找不到 manifest」。
 *    ⇒ 本脚本进 dist 目录里打 `zip -r out.zip .`，并**事后校验**根目录里确有 manifest.json。
 *
 * ② **别把源码/测试/map 一起打进去**（包会大好几倍，商店会警告，审稿人也会皱眉）。
 *    默认排除：.DS_Store、*.map、*.ts、*.tsx、*.md、*.git*、node_modules、__tests__。
 *    要保留 map 就加 --keep-maps。
 *
 * ③ **打完必须自证**：读 zip 里的 manifest.json，拿到版本号、字节数、sha256。
 *    「manifest.json 版本对得上」**不等于**「这个 zip 是刚打的」——
 *    忘了重新 build 就打包，版本号照样是对的（这坑本仓踩过）。
 *    ⇒ 本脚本顺手比一下 mtime：产物比源码旧 ⇒ 提醒「产物可能落后于源码」。
 *
 * ④ **重打之前必须删掉旧包**（2026-10-26 实测踩到）。
 *    `zip -r out.zip .` 对**已存在**的归档是**增量更新**：它只覆盖同名条目，
 *    **上一次构建留下的旧条目会原样留在包里** ⇒ 打包体积翻倍、条目数多出
 *    一堆带旧 hash 的重复文件（本仓实测：49 条 / 346 KB 变成 60 条 / 691 KB）。
 *    ⇒ 本脚本在打包前 `rm` 掉旧包 ⇒ 每次打出来的包**只含这一次**的产物。
 *
 * 打完把 sha256 记进发版台账：将来复现、核对、传给守候脚本都要用。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const positional = argv.filter((a) => !a.startsWith('--'));
const distDir = positional[0];
const keepMaps = flags.includes('--keep-maps');
const excludes = argv
  .map((a, i) => (a === '--exclude' ? argv[i + 1] : null))
  .filter(Boolean);

if (!distDir) {
  console.error('用法：node zip-extension.mjs <distDir> [outZip] [--keep-maps] [--exclude <pattern>]');
  process.exit(2);
}
const DIST = resolve(distDir);
if (!existsSync(DIST) || !statSync(DIST).isDirectory()) {
  console.error(`找不到产物目录：${DIST}`);
  process.exit(2);
}
const manifestPath = join(DIST, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`${DIST} 里没有 manifest.json —— 这不是构建产物的根目录？`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const version = manifest.version ?? '(无 version 字段)';

const OUT = resolve(positional[1] ?? join(DIST, '..', `extension-${manifest.version ?? 'unknown'}.zip`));

// ── 排除清单 ───────────────────────────────────────────────────────────────
const patterns = [
  '.DS_Store',
  '*/.DS_Store',
  '*/node_modules/*',
  '.git*',
  '*/.git*',
  '*/__tests__/*',
  '*/.github/*',
  '*.md',
  '*.ts',
  '*.tsx',
  ...(keepMaps ? [] : ['*.map']),   // Info-ZIP 的 * 也能跨 '/'，一条就够
  ...excludes,
];

// ── 打 zip（进目录里打 ⇒ 根目录就是 dist 的内容）──────────────────────────
if (existsSync(OUT)) {
  // ⚠️ 必须**先删**：`zip -r` 对已存在的归档是**增量更新** ⇒ 旧条目会留在包里
  //   （2026-10-26 实测：49 条 / 346 KB 变成 60 条 / 691 KB，一堆带旧 hash
  //   的重复文件被一起发上了商店）。
  console.log(`覆盖已有包（先删旧包，避免旧条目残留）：${OUT}`);
  rmSync(OUT, { force: true });
}
const args = ['-r', '-X', '-q', OUT, '.', '-x', ...patterns];
execFileSync('zip', args, { cwd: DIST, stdio: ['ignore', 'inherit', 'inherit'] });

// ── 自证 1：根目录里必须有 manifest.json（不能多套一层目录）───────────────
const listing = execFileSync('unzip', ['-Z1', OUT], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const entries = listing.split('\n').filter(Boolean);
const manifestEntries = entries.filter((e) => e === 'manifest.json' || e.endsWith('/manifest.json'));
if (manifestEntries.length === 0) {
  console.error('打包失败：zip 里找不到 manifest.json');
  process.exit(1);
}
if (manifestEntries[0] !== 'manifest.json') {
  console.error(
    `打包失败：manifest.json 在 zip 里的位置是「${manifestEntries[0]}」—— ` +
      '商店要求它在**根目录**（多套一层目录会被判「找不到 manifest」）。',
  );
  process.exit(1);
}

// ── 自证 2：产物是不是比源码旧（忘了 rebuild 的经典坑）────────────────────
const newestSource = (() => {
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build') continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);           // 断掉的软链会抛 ⇒ 跳过，别让整次扫描挂掉
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else newest = Math.max(newest, st.mtimeMs);
    }
  };
  try {
    walk(resolve(process.cwd()), 0);
  } catch {
    /* 扫不动就算了，不拦 */
  }
  return newest;
})();
const distMtime = statSync(OUT).mtimeMs;
if (newestSource > distMtime + 1000) {
  console.warn(
    `⚠️  产物比源码旧（src 最新 ${new Date(newestSource).toLocaleString()}，` +
      `zip ${new Date(distMtime).toLocaleString()}）—— 多半是**忘了重新 build**。` +
      'manifest 版本号对得上也说明不了产物是新的。',
  );
}

// ── 自证 3：版本 / 大小 / sha256 ──────────────────────────────────────────
const buf = readFileSync(OUT);
const sha = createHash('sha256').update(buf).digest('hex');
console.log(`✓ 打包完成：${OUT}`);
console.log(`  manifest 版本 : ${version}`);
console.log(`  字节数        : ${buf.length.toLocaleString()}`);
console.log(`  sha256        : ${sha}`);
console.log(`  条目数        : ${entries.length}`);
console.log('  ⇒ 把这个 sha256 记进发版台账（守候脚本也要用它做新鲜度自检）。');
