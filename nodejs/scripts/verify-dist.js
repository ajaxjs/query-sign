/**
 * 校验构建产物：CJS 与 ESM 双格式都能加载、类型声明齐全，
 * 且两者对全部 fixture 的计算结果一致。
 *
 * 用法：node scripts/verify-dist.js
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadFixtures, runFixtures } from '../../test/fixture-utils.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..');
const require = createRequire(import.meta.url);

const expectedFiles = [
  'dist/cjs/query-sign.js',
  'dist/cjs/query-sign.d.ts',
  'dist/cjs/package.json',
  'dist/esm/query-sign.js',
  'dist/esm/query-sign.d.ts',
  'dist/esm/package.json',
];

for (const rel of expectedFiles) {
  assert.ok(existsSync(resolve(pkgRoot, rel)), `构建产物缺失: ${rel}`);
}

const cjs = require(resolve(pkgRoot, 'dist/cjs/query-sign.js'));
const esm = await import(pathToFileURL(resolve(pkgRoot, 'dist/esm/query-sign.js')).href);

assert.equal(typeof cjs.QuerySign, 'function', 'CJS 产物未导出 QuerySign');
assert.equal(typeof cjs.default, 'function', 'CJS 产物未导出 default');
assert.equal(typeof esm.QuerySign, 'function', 'ESM 产物未导出 QuerySign');
assert.equal(typeof esm.default, 'function', 'ESM 产物未导出 default');
assert.equal(cjs.SPEC_VERSION, esm.SPEC_VERSION, 'CJS / ESM 的 SPEC_VERSION 不一致');

const { cases } = loadFixtures(resolve(repoRoot, 'test/fixtures.json'));

const results = [
  ['cjs', runFixtures(cjs.QuerySign, cases)],
  ['esm', runFixtures(esm.QuerySign, cases)],
];

let failed = false;
for (const [format, { passed, failures }] of results) {
  if (failures.length > 0) {
    failed = true;
    console.error(`[query-sign] ${format} 产物 fixture 失败 ${failures.length} 项:`);
    for (const f of failures) console.error(`  - ${f}`);
  } else {
    console.log(`[query-sign] ${format} 产物通过全部 ${passed} 个 fixture`);
  }
}

// CJS 与 ESM 必须逐个用例产出相同签名
for (const fixture of cases) {
  if (fixture.throws) continue;
  const a = new cjs.QuerySign(fixture.options);
  const b = new esm.QuerySign(fixture.options);
  a.data(fixture.data);
  b.data(fixture.data);
  assert.equal(a.getSign(), b.getSign(), `[${fixture.name}] CJS/ESM 签名不一致`);
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log('[query-sign] dist 产物校验通过');
}
