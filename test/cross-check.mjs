/**
 * 跨语言模糊交叉验证。
 *
 * 用 Node.js 参考实现随机生成大量载荷并计算签名，再交给 PHP 实现独立重算，
 * 逐字段比对 stringToSign / sign / toString。这是「不同语言签名必须一致」
 * 最直接的证据，覆盖 fixtures 之外的随机组合。
 *
 * 用法：
 *   node test/cross-check.mjs                     默认 500 例
 *   node test/cross-check.mjs 2000                指定例数
 *   node test/cross-check.mjs 2000 --seed=12345   固定随机种子（复现失败）
 *   node test/cross-check.mjs --php=php8.3        指定 PHP 可执行文件
 *   node test/cross-check.mjs --keep              保留中间文件便于排查
 *
 * 退出码：0 完全一致，1 存在不一致，2 环境/参数错误。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decodeMarkers } from './fixture-utils.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const tmpDir = resolve(here, '.tmp');

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
let count = 500;
let seed = Date.now() % 2147483647;
let phpBin = process.env.PHP_BINARY || 'php';
let keep = false;

for (const arg of argv) {
  if (/^\d+$/.test(arg)) {
    count = Number.parseInt(arg, 10);
  } else if (arg.startsWith('--seed=')) {
    seed = Number.parseInt(arg.slice(7), 10);
  } else if (arg.startsWith('--php=')) {
    phpBin = arg.slice(6);
  } else if (arg === '--keep') {
    keep = true;
  } else if (arg === '-h' || arg === '--help') {
    console.log('用法: node test/cross-check.mjs [count] [--seed=N] [--php=BIN] [--keep]');
    process.exit(0);
  } else {
    console.error(`未知参数: ${arg}`);
    process.exit(2);
  }
}

if (!Number.isFinite(count) || count <= 0) {
  console.error('count 必须是正整数');
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 可复现的随机源（mulberry32）
 * ------------------------------------------------------------------ */

function mulberry32(initial) {
  let a = initial >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(seed);

const pick = (list) => list[Math.floor(rnd() * list.length)];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

/* ------------------------------------------------------------------ *
 * 随机数据生成
 * ------------------------------------------------------------------ */

// 值可以包含任意字符（会被 RFC 3986 编码）
const VALUE_CHARS = [
  'a', 'b', 'z', 'A', 'Z', '0', '9', '_', '-', '.', '~',
  ' ', '!', '"', "'", '(', ')', '*', '+', '&', '=', '?', '#',
  '%', '/', ':', ';', '<', '>', '@', '[', ']', '^', '`',
  '{', '|', '}', '\\', ',', '$',
  '中', '文', '张三', '订单号', '🙂', '🚀', 'é', 'ü', 'ñ', 'Ω', 'Ж', 'あ', 'あア',
];

// 键必须排除 [ ]，否则可能与嵌套扁平化结果产生重复键（规范规定该情况抛错）；
// 同时排除 $，避免随机生成的键恰好撞上 fixtures 的类型标记（如 "$float"）
const KEY_CHARS = VALUE_CHARS.filter((c) => c !== '[' && c !== ']' && c !== '$');

const NUMERIC_KEYS = ['0', '1', '9', '10', '100', '2147483647'];

function randomString(maxLength = 24) {
  const len = int(0, maxLength);
  let out = '';
  for (let i = 0; i < len; i++) out += pick(VALUE_CHARS);
  return out;
}

function randomKey() {
  if (rnd() < 0.08) return pick(NUMERIC_KEYS);
  if (rnd() < 0.03) return '';
  const len = int(1, 10);
  let out = '';
  for (let i = 0; i < len; i++) out += pick(KEY_CHARS);
  return out;
}

/** 覆盖 JS / PHP 浮点格式化各个分支的取值 */
function randomFloat() {
  const branch = rnd();
  if (branch < 0.2) return int(-1000000, 1000000);            // 整数值浮点
  if (branch < 0.4) return rnd() * 1e6 - 5e5;                 // 常规小数
  if (branch < 0.55) return rnd() * 1e-5;                     // 定点/指数边界（1e-6 附近）
  if (branch < 0.7) return Math.pow(10, int(-20, 20)) * int(1, 9);
  if (branch < 0.8) return Math.pow(10, int(15, 25));         // 大数与 1e21 边界
  if (branch < 0.9) return rnd() * Number.MAX_SAFE_INTEGER;
  return pick([0.1, 1 / 3, 1e-6, 1e-7, 1e21, 1e20, 5e-324, 1.7976931348623157e308, -0.0, 2.0]);
}

function randomScalar(depth) {
  const branch = rnd();
  if (branch < 0.34) return randomString();
  if (branch < 0.52) return int(-1e9, 1e9);
  if (branch < 0.62) return rnd() < 0.5;
  if (branch < 0.72) return null;
  if (branch < 0.84) return { $float: randomFloat() };
  if (branch < 0.88) return '';
  if (depth < 3 && branch < 0.94) return randomList(depth + 1);
  if (depth < 3) return randomMap(depth + 1);
  return randomString();
}

function randomList(depth) {
  const len = int(0, 4);
  const out = [];
  for (let i = 0; i < len; i++) out.push(randomScalar(depth));
  return out;
}

function randomMap(depth) {
  const len = int(0, 5);
  const out = {};
  for (let i = 0; i < len; i++) {
    const key = randomKey();
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    out[key] = randomScalar(depth);
  }
  return out;
}

/**
 * 顶层数据随机选择映射或列表。
 *
 * 这是跨语言歧义的高发区：`[10, 20]` 与 `{"0":10,"1":20}` 在 JSON 中形态不同，
 * 但 PHP `json_decode` 会把后者解析成前者的等价列表，两端必须产出相同签名。
 */
function randomData(depth) {
  return rnd() < 0.25 ? randomList(depth) : randomMap(depth);
}

function randomOptions() {
  const options = {
    secret: randomString(32) || 'fallback-secret',
  };
  if (rnd() < 0.5) options.signField = pick(['sign', 'signature', 'sign', '_sign', 'X-Sign']);
  if (rnd() < 0.5) options.algorithm = pick(['md5', 'sha1', 'sha256', 'sha256', 'sha512', 'sha224', 'sha384']);
  if (rnd() < 0.3) options.encoding = 'base64';
  if (rnd() < 0.2) options.uppercase = true;
  if (rnd() < 0.2) options.loose = true;
  return options;
}

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

const distEntry = resolve(root, 'nodejs/dist/esm/query-sign.js');
let QuerySign;
try {
  ({ QuerySign } = await import(pathToFileURL(distEntry).href));
} catch (err) {
  console.error(`无法加载 Node.js 构建产物: ${distEntry}`);
  console.error('请先执行: cd nodejs && npm run build');
  console.error(String(err && err.message ? err.message : err));
  process.exit(2);
}

const cases = [];
const nodeResults = [];

for (let i = 0; i < count; i++) {
  const options = randomOptions();
  const data = randomData(0);
  cases.push({ options, data });

  try {
    const qs = new QuerySign(options);
    qs.data(decodeMarkers(data));
    nodeResults.push({
      ok: true,
      stringToSign: qs.getStringToSign(),
      sign: qs.getSign(),
      toString: qs.toString(),
      verified: qs.verify(qs.getSign()),
    });
  } catch (err) {
    nodeResults.push({ ok: false, error: `${err.name}: ${err.message}` });
  }
}

mkdirSync(tmpDir, { recursive: true });
const casesFile = resolve(tmpDir, 'cross-check-cases.json');
const phpOutFile = resolve(tmpDir, 'cross-check-php.json');
writeFileSync(casesFile, JSON.stringify(cases), 'utf8');

let phpRaw;
try {
  phpRaw = execFileSync(phpBin, [resolve(here, 'cross-check.php'), casesFile], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  console.error(`调用 PHP 失败（${phpBin}）: ${err.message}`);
  if (err.stderr) console.error(err.stderr.toString());
  process.exit(2);
}

writeFileSync(phpOutFile, phpRaw, 'utf8');

let phpResults;
try {
  phpResults = JSON.parse(phpRaw);
} catch (err) {
  console.error('PHP 输出不是合法 JSON:');
  console.error(phpRaw.slice(0, 2000));
  process.exit(2);
}

if (!Array.isArray(phpResults) || phpResults.length !== cases.length) {
  console.error(`PHP 返回结果数量不匹配: 期望 ${cases.length}，实际 ${Array.isArray(phpResults) ? phpResults.length : 'n/a'}`);
  process.exit(2);
}

const mismatches = [];
for (let i = 0; i < cases.length; i++) {
  const n = nodeResults[i];
  const p = phpResults[i];

  if (n.ok !== p.ok) {
    mismatches.push({ index: i, reason: n.ok ? `PHP 抛错: ${p.error}` : `Node 抛错: ${n.error}` });
    continue;
  }
  if (!n.ok) continue;

  for (const field of ['stringToSign', 'sign', 'toString', 'verified']) {
    if (n[field] !== p[field]) {
      mismatches.push({ index: i, field, node: n[field], php: p[field] });
    }
  }
}

if (!keep) {
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`种子 ${seed}，${count} 例随机载荷，PHP: ${phpBin}`);

if (mismatches.length === 0) {
  console.log(`\x1b[32m跨语言交叉验证通过\x1b[0m：Node.js 与 PHP 对全部 ${count} 例产出完全一致的签名`);
  process.exit(0);
}

console.error(`\x1b[31m发现 ${mismatches.length} 处不一致\x1b[0m（复现: node test/cross-check.mjs ${count} --seed=${seed}）`);
for (const m of mismatches.slice(0, 10)) {
  console.error(`  #${m.index} ${m.reason || m.field}`);
  if (!m.reason) {
    console.error(`    node: ${JSON.stringify(m.node)}`);
    console.error(`    php : ${JSON.stringify(m.php)}`);
  }
  console.error(`    data: ${JSON.stringify(cases[m.index].data)}`);
  console.error(`    opts: ${JSON.stringify(cases[m.index].options)}`);
}
if (mismatches.length > 10) {
  console.error(`  ... 其余 ${mismatches.length - 10} 处省略`);
}
process.exit(1);
