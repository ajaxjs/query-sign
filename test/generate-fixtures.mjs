/**
 * 生成跨语言黄金用例集 test/fixtures.json。
 *
 * 用法（需先构建 nodejs 产物）：
 *   node test/generate-fixtures.mjs
 *
 * 生成过程以 Node.js 实现为参考实现，同时对每个用例校验「键插入顺序无关」这一
 * 规范不变量；任一用例违反即中止生成，避免把错误结果固化成黄金值。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { decodeMarkers } from './fixture-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = resolve(root, 'test/fixtures.json');
const nodePkg = JSON.parse(
  readFileSync(resolve(root, 'nodejs/package.json'), 'utf8')
);

const { QuerySign, SPEC_VERSION } = await import(
  pathToFileURL(resolve(root, 'nodejs/dist/esm/query-sign.js')).href
);

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 深拷贝并反转每一层的键顺序，用于验证签名与插入顺序无关 */
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).reverse()) out[key] = reverseKeys(value[key]);
    return out;
  }
  return value;
}

function compute(options, data) {
  const qs = new QuerySign(options);
  qs.data(data);
  return {
    stringToSign: qs.getStringToSign(),
    sign: qs.getSign(),
    toString: qs.toString(),
  };
}

/* ------------------------------------------------------------------ *
 * 用例表
 * ------------------------------------------------------------------ */

const SECRET = 'qs-secret-2024';

/** 常用 options 变体 */
const O = {
  def: { secret: SECRET },
  md5: { secret: SECRET, algorithm: 'md5' },
  sha1: { secret: SECRET, algorithm: 'sha1' },
  sha512: { secret: SECRET, algorithm: 'sha512' },
  base64: { secret: SECRET, encoding: 'base64' },
  upper: { secret: SECRET, uppercase: true },
  customField: { secret: SECRET, signField: 'signature' },
  customSignMap: { secret: SECRET, signMap: 'signature_map' },
  loose: { secret: SECRET, loose: true },
};

const cases = [
  {
    name: 'basic-flat-string-and-number',
    options: O.def,
    data: { appId: 'wx1234567890', ts: 1700000000, nonce: 'a1b2c3' },
  },
  {
    name: 'insertion-order-a',
    options: O.def,
    data: { a: 1, b: 2, c: 3 },
  },
  {
    name: 'insertion-order-b-same-as-a',
    options: O.def,
    data: { c: 3, b: 2, a: 1 },
  },
  {
    name: 'sort-keys-by-utf8-bytes',
    options: O.def,
    data: { b: '1', A: '2', a: '3', B: '4', 0: '5', _: '6', '~': '7', Z: '8', 中: '9' },
  },
  {
    name: 'sort-utf8-vs-utf16-divergence',
    // '\uFFFF' 的 UTF-8 字节 (EF BF BF) 小于 emoji (F0 9F 99 82)，
    // 但 UTF-16 码元顺序相反 —— 必须按 UTF-8 字节排序
    options: O.def,
    data: { '\uFFFF': 'private-use', '\uD83D\uDE42': 'emoji' },
  },
  {
    name: 'numeric-string-keys-sorted-lexically',
    options: O.def,
    data: { 10: 'a', 9: 'b', 1: 'c', 100: 'd' },
  },
  {
    name: 'nested-object',
    options: O.def,
    data: { user: { id: 7, name: 'tom' }, verbose: true },
  },
  {
    name: 'nested-array',
    options: O.def,
    data: { ids: [10, 20, 30], tag: 'x' },
  },
  {
    name: 'deep-mixed-nesting',
    options: O.def,
    data: {
      order: {
        id: 'ORD-1',
        items: [
          { sku: 'A', qty: 2, tags: ['hot', 'new'] },
          { sku: 'B', qty: 1, tags: [] },
        ],
        coupon: { code: 'SAVE10', stackable: false },
      },
    },
  },
  {
    name: 'null-dropped-empty-string-kept',
    options: O.def,
    data: { keep: '', drop: null, also: 'v' },
  },
  {
    name: 'boolean-normalized-to-true-false',
    options: O.def,
    data: { t: true, f: false, n: 1, m: 0 },
  },
  {
    name: 'empty-nested-containers-dropped',
    options: O.def,
    data: { obj: {}, arr: [], real: 'yes', nested: { empty: {} } },
  },
  {
    name: 'array-with-null-holes-keeps-index',
    options: O.def,
    data: { a: [10, null, 20] },
  },
  {
    // SPEC 3.1：签名时 data 中不得出现 signField / signMap，否则视为关键字冲突
    name: 'top-level-sign-field-conflict',
    options: O.def,
    data: { a: 1, sign: 'stale-signature' },
    throws: true,
  },
  {
    name: 'nested-sign-field-not-excluded',
    options: O.def,
    data: { a: 1, meta: { sign: 'nested-participates' } },
  },
  {
    name: 'custom-sign-field',
    options: O.customField,
    data: { a: 1, sign: 'kept-because-not-signField' },
  },
  {
    name: 'custom-sign-field-conflict',
    options: O.customField,
    data: { a: 1, signature: 'dropped' },
    throws: true,
  },
  {
    name: 'custom-sign-map-field',
    options: O.customSignMap,
    data: { a: 1, b: 'x' },
  },
  {
    name: 'sign-map-key-conflict',
    options: O.def,
    data: { a: 1, sign_map: 'x' },
    throws: true,
  },
  {
    name: 'empty-data',
    options: O.def,
    data: {},
  },
  {
    name: 'only-sign-field-conflict',
    options: O.def,
    data: { sign: 'whatever' },
    throws: true,
  },
  {
    // sign_map 用 `+` 连接字段名，字段名里的 `+` / `%` 必须转义，保证可无歧义还原
    name: 'sign-map-field-name-escaping',
    options: O.def,
    data: { 'a+b': 1, '100%': 2, name: 'kevin' },
  },
  {
    name: 'rfc3986-special-chars',
    options: O.def,
    data: {
      space: 'a b',
      plus: 'a+b',
      amp: 'a&b',
      eq: 'a=b',
      pct: '100%',
      tilde: 'a~b',
      bang: "a!b",
      quote: "a'b",
      paren: 'a(b)c',
      star: 'a*b',
      slash: 'a/b?c#d',
      bracket: 'a[b]',
    },
  },
  {
    name: 'unicode-values-and-keys',
    options: O.def,
    data: { 名称: '张三', emoji: '🙂🚀', mixed: 'abc中文123' },
  },
  {
    name: 'integer-values',
    options: O.def,
    data: { zero: 0, neg: -5, max32: 2147483647, safeMax: 9007199254740991 },
  },
  {
    name: 'float-values',
    // $float 标记：JS 侧得到 Number，PHP 侧强制 (float)，
    // 用于覆盖两端浮点格式化差异
    options: O.def,
    data: {
      integral: { $float: 2 },
      hundred: { $float: 100 },
      big: { $float: 120000 },
      tenth: { $float: 0.1 },
      third: { $float: 0.3333333333333333 },
      micro: { $float: 1e-6 },
      nano: { $float: 1e-7 },
      negNano: { $float: -1.5e-7 },
      huge: { $float: 1e21 },
      safeMaxFloat: { $float: 9007199254740992 },
    },
  },
  {
    name: 'bigint-value',
    // PHP 无原生大整数，按十进制字符串传入，两端结果一致
    options: { secret: SECRET },
    data: { big: { $bigint: '12345678901234567890123' }, normal: 1 },
  },
  {
    name: 'algo-md5',
    options: O.md5,
    data: { a: 'x', b: 1 },
  },
  {
    name: 'algo-sha1',
    options: O.sha1,
    data: { a: 'x', b: 1 },
  },
  {
    name: 'algo-sha512',
    options: O.sha512,
    data: { a: 'x', b: 1 },
  },
  {
    name: 'encoding-base64',
    options: O.base64,
    data: { a: 'x', b: 1, c: { d: [1, 2] } },
  },
  {
    name: 'hex-uppercase',
    options: O.upper,
    data: { a: 'x', b: 1 },
  },
  {
    name: 'secret-with-unicode',
    options: { secret: '密钥🔑-ünïcødé' },
    data: { a: 1 },
  },
  {
    name: 'long-value',
    options: O.def,
    data: { payload: 'x'.repeat(1024), tail: 'end' },
  },
  {
    name: 'realistic-gateway-payload',
    options: { secret: 'prod-secret', signField: 'sign', algorithm: 'sha256' },
    data: {
      method: 'trade.create',
      app_id: '2021000000000001',
      charset: 'utf-8',
      version: '1.0',
      timestamp: '2024-05-01 12:30:45',
      biz_content: JSON.stringify({
        out_trade_no: 'T20240501123045',
        total_amount: '88.88',
        subject: '测试订单 & 特殊字符 =/+%',
        buyer_id: '2088000000000001',
      }),
      extra: { notify_url: 'https://example.com/cb?a=1&b=2', debug: false },
    },
  },
  {
    name: 'throws-duplicate-flat-key',
    options: O.def,
    data: { 'a[b]': 'scalar', a: { b: 'nested' } },
    throws: true,
  },
  {
    // 顶层列表：下标直接作为键名（`0=10`），而非 `[0]=10`
    name: 'top-level-list-of-scalars',
    options: O.def,
    data: [10, 20, 30],
  },
  {
    // 互操作关键用例：同一份 JSON，JS 解析为对象（键 "0"/"1"），
    // PHP json_decode 解析为列表（键 int 0/1），两端必须产出相同签名
    name: 'top-level-numeric-string-keys-interop',
    options: O.def,
    data: { 0: 'x', 1: 'y', 2: 'z' },
  },
  {
    name: 'top-level-list-nested',
    options: O.def,
    data: [{ a: 1 }, [1, 2], { b: { c: 'deep' } }],
  },
  {
    // null 元素被丢弃，但下标不重排（保留 0 与 2）
    name: 'top-level-list-with-null-hole',
    options: O.def,
    data: [1, null, 3],
  },
  {
    name: 'top-level-list-empty',
    options: O.def,
    data: [],
  },
  {
    // 顶层列表不存在字符串键，签名字段照常追加为普通键
    name: 'top-level-list-with-base64',
    options: O.base64,
    data: ['a', 'b', 'c'],
  },
];

/* ------------------------------------------------------------------ *
 * 生成
 * ------------------------------------------------------------------ */

const generated = [];
let invariantChecks = 0;

for (const item of cases) {
  const entry = {
    name: item.name,
    options: item.options,
    data: item.data,
    throws: item.throws === true,
  };

  if (entry.throws) {
    generated.push(entry);
    continue;
  }

  const decoded = decodeMarkers(item.data);
  const expect = compute(item.options, decoded);

  // 规范不变量：签名结果与键插入顺序无关
  const reversed = compute(item.options, reverseKeys(decoded));
  invariantChecks++;
  if (reversed.stringToSign !== expect.stringToSign) {
    throw new Error(
      `用例 "${item.name}" 违反键序无关不变量:\n` +
        `  正序: ${expect.stringToSign}\n` +
        `  逆序: ${reversed.stringToSign}`
    );
  }

  entry.expect = expect;
  generated.push(entry);
}

const doc = {
  $comment:
    '由 test/generate-fixtures.mjs 生成，请勿手工编辑。所有语言实现必须逐字段匹配本文件。',
  specVersion: SPEC_VERSION,
  referenceImplementation: `query-sign (nodejs) v${nodePkg.version}`,
  cases: generated,
};

writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');

console.log(
  `[query-sign] 已生成 ${generated.length} 个用例（其中 ${generated.filter((c) => c.throws).length} 个抛错用例），` +
    `键序无关不变量校验 ${invariantChecks} 次 -> ${outFile}`
);
