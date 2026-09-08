/**
 * 构建后处理：为 CJS / ESM 两个产物目录各自补一个 package.json，
 * 显式声明模块类型，避免受根 package.json 的 "type" 字段影响。
 */
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  { dir: 'dist/cjs', type: 'commonjs' },
  { dir: 'dist/esm', type: 'module' },
];

for (const { dir, type } of targets) {
  const abs = resolve(pkgRoot, dir);
  if (!existsSync(resolve(abs, 'query-sign.js'))) {
    throw new Error(`[query-sign] 产物缺失: ${dir}/query-sign.js，请先执行 tsc 构建`);
  }
  writeFileSync(
    resolve(abs, 'package.json'),
    JSON.stringify({ type, sideEffects: false }, null, 2) + '\n',
    'utf8'
  );
  console.log(`[query-sign] ${dir}/package.json -> { "type": "${type}" }`);
}
