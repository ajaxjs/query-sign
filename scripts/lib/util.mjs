/**
 * 发布脚本的公共工具：日志着色、子进程执行、参数解析、JSON 读写。
 *
 * 之所以自己实现而不用第三方库：发布脚本必须能在「刚 clone、尚未 npm install」
 * 的干净环境下运行，因此根目录 scripts/ 下不允许有任何外部依赖。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 仓库根目录 */
export const ROOT = resolve(here, '..', '..');

/** Node.js 子包目录 */
export const NODEJS_DIR = resolve(ROOT, 'nodejs');

/** PHP 子包目录 */
export const PHP_DIR = resolve(ROOT, 'php');

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

const useColor =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  (process.stdout.hasColors ? process.stdout.hasColors() : process.platform !== 'win32' || !!process.env.WT_SESSION || !!process.env.TERM);

const paint = (text, code) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

export const log = {
  /** 阶段标题 */
  step(text) {
    process.stdout.write(`\n${paint(`▸ ${text}`, '1;36')}\n`);
  },
  ok(text) {
    process.stdout.write(`  ${paint('✓', '32')} ${text}\n`);
  },
  info(text) {
    process.stdout.write(`  ${paint('·', '90')} ${text}\n`);
  },
  warn(text) {
    process.stdout.write(`  ${paint('!', '33')} ${text}\n`);
  },
  fail(text) {
    process.stderr.write(`  ${paint('✗', '31')} ${text}\n`);
  },
  plain(text = '') {
    process.stdout.write(`${text}\n`);
  },
};

/** 带框的醒目标题 */
export function banner(title) {
  const line = '─'.repeat(Math.max(title.length + 4, 40));
  log.plain(paint(`\n┌${line}┐`, '1'));
  log.plain(paint(`│  ${title}`, '1'));
  log.plain(paint(`└${line}┘`, '1'));
}

/* ------------------------------------------------------------------ *
 * 子进程
 * ------------------------------------------------------------------ */

/**
 * Windows 上 `npm` 实际是 `npm.cmd`，而 Node 20+ 出于 CVE-2024-27980 的修复，
 * 禁止不经 shell 直接 spawn `.bat`/`.cmd`（会抛 EINVAL）。
 *
 * 这里不用 `shell: true`（会把参数交给 cmd.exe 二次解析，含空格路径不安全），
 * 而是定位 npm 的 JS 入口，用当前 Node 解释器直接执行。
 *
 * @type {string[]|null} 缓存解析结果：`[node, npm-cli.js]` 或 `null`
 */
let npmCommandCache;

function resolveNpmCommand() {
  if (npmCommandCache !== undefined) return npmCommandCache;

  const nodeDir = dirname(process.execPath);
  const candidates = [
    // Windows / 官方安装包：与 node 可执行文件同级
    resolve(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // POSIX 布局：node 在 bin/，全局包在 ../lib/node_modules
    resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // 部分版本管理器（fnm / volta / nvm）的布局
    resolve(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      npmCommandCache = [process.execPath, candidate];
      return npmCommandCache;
    }
  }

  npmCommandCache = null;
  return npmCommandCache;
}

/**
 * 执行 npm。返回 null 表示找不到 npm 的 JS 入口。
 *
 * @param {string[]} args
 * @param {{cwd?: string, allowFailure?: boolean, quiet?: boolean}} [options]
 */
export function runNpm(args, options = {}) {
  const command = resolveNpmCommand();
  if (command === null) {
    throw new ReleaseError(
      '找不到 npm 的 CLI 入口 npm-cli.js。请确认 Node.js 安装完整（自带 npm），' +
        `或在 PATH 中提供 npm。已探测的位置基于: ${process.execPath}`
    );
  }
  return run(command[0], [command[1], ...args], options);
}

/** npm 是否可用 */
export function hasNpm() {
  try {
    return runNpm(['--version'], { quiet: true, allowFailure: true }).ok;
  } catch {
    return false;
  }
}

/** npm 版本号；不可用时返回 'unknown' */
export function npmVersion() {
  try {
    const result = runNpm(['--version'], { quiet: true, allowFailure: true });
    return result.ok ? result.stdout.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 执行命令并实时透传输出。
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, allowFailure?: boolean, quiet?: boolean}} [options]
 * @returns {{ok: boolean, status: number|null, stdout: string, stderr: string}}
 */
export function run(command, args, options = {}) {
  const { cwd = ROOT, allowFailure = false, quiet = false } = options;

  if (!quiet) {
    // 用 node 直接跑 JS 入口时（如 npm-cli.js），只展示脚本名，避免刷屏的绝对路径
    const display =
      command === process.execPath && args[0]
        ? `node ${basename(args[0])} ${args.slice(1).join(' ')}`.trim()
        : `${command} ${args.join(' ')}`;
    log.info(paint(`$ ${display}`, '90'));
  }

  const result = spawnSync(command, args, {
    cwd,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: false,
  });

  if (result.error) {
    const message = `无法执行 ${command}: ${result.error.message}`;
    if (allowFailure) {
      log.warn(message);
      return { ok: false, status: null, stdout: '', stderr: message };
    }
    throw new ReleaseError(message);
  }

  const ok = result.status === 0;
  if (!ok && !allowFailure) {
    throw new ReleaseError(
      `命令失败（退出码 ${result.status}）: ${command} ${args.join(' ')}\n` +
        `  工作目录: ${cwd}`
    );
  }

  return {
    ok,
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

/** 执行命令并捕获输出（不透传），失败时返回 ok:false 而不抛错 */
export function capture(command, args, options = {}) {
  return run(command, args, { ...options, quiet: true, allowFailure: true });
}

/** 探测某个可执行文件是否可用 */
export function hasBinary(command, args = ['--version']) {
  return capture(command, args).ok;
}

/* ------------------------------------------------------------------ *
 * 错误类型
 * ------------------------------------------------------------------ */

/** 可预期的发布流程错误：打印消息即可，不需要堆栈 */
export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
  }
}

/* ------------------------------------------------------------------ *
 * 文件
 * ------------------------------------------------------------------ */

/** 读取 JSON（保留原始文本，便于原样回写时不破坏格式） */
export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 以 2 空格缩进 + 末尾换行写回 JSON */
export function writeJson(file, value, indent = 2) {
  writeFileSync(file, `${JSON.stringify(value, null, indent)}\n`, 'utf8');
}

/** composer.json 沿用 4 空格缩进 */
export function writeComposerJson(file, value) {
  writeJson(file, value, 4);
}

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

/**
 * 极简参数解析：支持 `--flag`、`--key=value`、`--key value` 与位置参数。
 *
 * @param {string[]} argv
 * @param {{flags?: string[], options?: string[], aliases?: Record<string, string>}} spec
 */
export function parseArgs(argv, spec) {
  const flags = new Set(spec.flags || []);
  const valued = new Set(spec.options || []);
  const aliases = spec.aliases || {};

  const result = { _: [] };
  for (const key of flags) result[key] = false;
  for (const key of valued) result[key] = undefined;

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];

    if (!arg.startsWith('-')) {
      result._.push(arg);
      continue;
    }

    arg = arg.replace(/^-+/, '');
    const eq = arg.indexOf('=');
    let key = eq === -1 ? arg : arg.slice(0, eq);
    let inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    key = aliases[key] || key;

    if (flags.has(key)) {
      if (inlineValue !== undefined) {
        throw new ReleaseError(`--${key} 是开关参数，不接受值`);
      }
      result[key] = true;
      continue;
    }

    if (valued.has(key)) {
      if (inlineValue === undefined) {
        inlineValue = argv[++i];
        if (inlineValue === undefined) {
          throw new ReleaseError(`--${key} 需要一个值`);
        }
      }
      result[key] = inlineValue;
      continue;
    }

    throw new ReleaseError(`未知参数: --${key}（用 --help 查看用法）`);
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * 交互确认
 * ------------------------------------------------------------------ */

/**
 * 发布前的二次确认。非交互环境（CI / 管道）下不阻塞：
 * 由调用方通过 `--no-input` 显式跳过确认。
 *
 * @param {string} question
 * @returns {Promise<boolean>}
 */
export async function confirm(question) {
  if (!process.stdin.isTTY) {
    log.warn('非交互式终端，跳过确认（如需强制执行请加 --no-input）');
    return false;
  }

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
