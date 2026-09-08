/**
 * 全仓库质量校验：Node.js 与 PHP 两端分别构建/测试，再做跨语言交叉验证。
 *
 * 这是发布前的必经关卡，也可单独运行：
 *   node scripts/verify.mjs              完整校验
 *   node scripts/verify.mjs --fuzz=2000  指定模糊测试例数
 *   node scripts/verify.mjs --no-fuzz    跳过模糊测试（仅跑 fixtures）
 *   node scripts/verify.mjs --php=php8.3 指定 PHP 可执行文件
 *
 * PHP 侧刻意直接用 `php` 调用脚本而非 `composer run-script`，
 * 这样在未安装 composer 的机器上也能完整校验。
 *
 * 退出码：0 全部通过，1 存在失败，2 参数错误。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  NODEJS_DIR,
  PHP_DIR,
  ROOT,
  ReleaseError,
  banner,
  capture,
  hasBinary,
  hasNpm,
  log,
  npmVersion,
  parseArgs,
  run,
  runNpm,
} from './lib/util.mjs';

let args;
try {
  args = parseArgs(process.argv.slice(2), {
    flags: ['no-fuzz', 'help', 'skip-install'],
    options: ['fuzz', 'php', 'seed'],
    aliases: { h: 'help' },
  });
} catch (err) {
  log.fail(err instanceof ReleaseError ? err.message : String(err));
  process.exit(2);
}

if (args.help) {
  log.plain(`用法: node scripts/verify.mjs [选项]

选项:
  --fuzz=N        跨语言模糊测试例数（默认 500）
  --no-fuzz       跳过模糊测试，仅跑共享 fixtures
  --seed=N        固定模糊测试随机种子（复现失败用）
  --php=BIN       指定 PHP 可执行文件（默认取 $PHP_BINARY 或 php）
  --skip-install  跳过 nodejs 依赖安装
  -h, --help      显示本帮助`);
  process.exit(0);
}

const phpBin = args.php || process.env.PHP_BINARY || 'php';
const fuzzCount = args.fuzz ? Number.parseInt(args.fuzz, 10) : 500;

if (!args['no-fuzz'] && (!Number.isFinite(fuzzCount) || fuzzCount <= 0)) {
  log.fail('--fuzz 必须是正整数');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 环境探测
 * ------------------------------------------------------------------ */

banner('环境探测');

if (!hasBinary(phpBin)) {
  log.fail(`找不到可用的 PHP（尝试执行 "${phpBin} --version"）`);
  log.plain('    请安装 PHP 7.4+，或用 --php=BIN 指定可执行文件路径');
  process.exit(1);
}
log.ok(`PHP: ${capture(phpBin, ['-r', 'echo PHP_VERSION;']).stdout.trim()}`);
log.ok(`Node: ${process.version}`);

if (!hasNpm()) {
  log.fail('找不到可用的 npm（Node.js 官方安装包自带 npm）');
  log.plain(`    已基于 ${process.execPath} 探测 npm-cli.js`);
  process.exit(1);
}
log.ok(`npm: ${npmVersion()}`);

const failures = [];

/* ------------------------------------------------------------------ *
 * Node.js 端
 * ------------------------------------------------------------------ */

banner('Node.js 端（类型检查 + 单测 + 双构建 + 产物校验）');

if (args['skip-install']) {
  log.info('--skip-install：跳过依赖安装');
} else if (existsSync(resolve(NODEJS_DIR, 'node_modules'))) {
  log.info('node_modules 已存在，跳过安装');
} else {
  log.info('未发现 node_modules，执行 npm install');
  runNpm(['install', '--no-audit', '--no-fund'], { cwd: NODEJS_DIR });
}

try {
  // check = typecheck + test + build + test:dist
  runNpm(['run', 'check'], { cwd: NODEJS_DIR });
  log.ok('Node.js 端全部通过');
} catch (err) {
  failures.push(`Node.js 端: ${err.message}`);
  log.fail('Node.js 端未通过');
}

/* ------------------------------------------------------------------ *
 * PHP 端
 * ------------------------------------------------------------------ */

banner('PHP 端（语法/元数据自检 + 单测 + 共享 fixtures）');

try {
  run(phpBin, [resolve(PHP_DIR, 'scripts/lint.php')], { cwd: PHP_DIR });
  run(phpBin, [resolve(PHP_DIR, 'tests/run.php')], { cwd: PHP_DIR });
  log.ok('PHP 端全部通过');
} catch (err) {
  failures.push(`PHP 端: ${err.message}`);
  log.fail('PHP 端未通过');
}

/* ------------------------------------------------------------------ *
 * 发布脚本自测
 * ------------------------------------------------------------------ */

banner('发布脚本自测（版本号计算 / 占位符扫描）');

try {
  // 传目录会被 Node 的 test runner 当成模块解析而报 MODULE_NOT_FOUND，
  // 必须传 glob（且由 Node 自己展开，因此不能用 shell）
  run(process.execPath, ['--test', 'scripts/lib/*.test.mjs'], { cwd: ROOT });
  log.ok('发布脚本自测通过');
} catch (err) {
  failures.push(`发布脚本自测: ${err.message}`);
  log.fail('发布脚本自测未通过');
}

/* ------------------------------------------------------------------ *
 * 跨语言交叉验证
 * ------------------------------------------------------------------ */

if (!args['no-fuzz'] && failures.length === 0) {
  banner(`跨语言模糊交叉验证（${fuzzCount} 例随机载荷）`);

  const fuzzArgs = [
    resolve(ROOT, 'test/cross-check.mjs'),
    String(fuzzCount),
    `--php=${phpBin}`,
  ];
  if (args.seed) fuzzArgs.push(`--seed=${args.seed}`);

  try {
    run(process.execPath, fuzzArgs, { cwd: ROOT });
    log.ok('两端对全部随机载荷产出完全一致的签名');
  } catch (err) {
    failures.push(`跨语言交叉验证: ${err.message}`);
    log.fail('发现跨语言签名不一致');
  }
} else if (failures.length > 0) {
  log.warn('前置检查未通过，跳过模糊测试');
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

if (failures.length > 0) {
  log.plain('');
  log.fail(`校验失败，共 ${failures.length} 项：`);
  for (const item of failures) log.plain(`    - ${item}`);
  process.exit(1);
}

banner('校验通过');
log.ok('Node.js 端：typecheck / 单测 / CJS+ESM 双产物 fixtures');
log.ok('PHP 端：lint / 单测 / 共享 fixtures');
log.ok('发布脚本：版本号计算 / 占位符扫描自测');
if (!args['no-fuzz']) log.ok(`跨语言：${fuzzCount} 例随机载荷签名逐字节一致`);
log.plain('');
process.exit(0);
