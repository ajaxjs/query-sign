/**
 * 语义化版本号计算。
 *
 * 独立成模块的原因：升版本出错属于「发布级事故」（发错版本无法从 npm 撤回），
 * 抽出来后可以脱离发布流程单独测试。
 */

import { ReleaseError } from './util.mjs';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?(?:\+([\w.]+))?$/;

/** 是否为合法的 `x.y.z` 版本串（不含预发布/构建元数据） */
export function isPlainVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

/** 是否为合法的语义化版本串（允许 `-beta.1` / `+build` 后缀） */
export function isSemver(value) {
  return typeof value === 'string' && SEMVER.test(value);
}

/**
 * 计算下一个版本号。
 *
 * @param {string} current 当前版本，如 `1.2.3` 或 `1.2.3-beta.1`
 * @param {'patch'|'minor'|'major'|string} level 升级级别，或直接给出目标版本号
 * @returns {string}
 * @throws {ReleaseError} 当前版本无法解析，或 level 非法
 */
export function nextVersion(current, level) {
  // 直接指定目标版本
  if (isPlainVersion(level)) return level;

  const matched = SEMVER.exec(current);
  if (!matched) {
    throw new ReleaseError(
      `无法解析当前版本号 "${current}"（期望 x.y.z 或 x.y.z-pre），` +
        '或直接传 --bump=1.2.3 指定目标版本'
    );
  }

  let major = Number(matched[1]);
  let minor = Number(matched[2]);
  let patch = Number(matched[3]);
  const prerelease = matched[4];

  switch (level) {
    case 'major':
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case 'minor':
      minor += 1;
      patch = 0;
      break;
    case 'patch':
      // 预发布版本升 patch 只是「转正」：1.2.3-beta.1 -> 1.2.3
      if (prerelease) return `${major}.${minor}.${patch}`;
      patch += 1;
      break;
    case 'prepatch':
      patch += 1;
      return `${major}.${minor}.${patch}-0`;
    case 'preminor':
      minor += 1;
      return `${major}.${minor}.0-0`;
    case 'premajor':
      major += 1;
      return `${major}.0.0-0`;
    default:
      throw new ReleaseError(
        `--bump 只接受 patch / minor / major / prepatch / preminor / premajor / x.y.z，` +
          `收到 "${level}"`
      );
  }

  // 升级后一律丢弃预发布后缀：1.2.3-beta.1 --bump=minor -> 1.3.0
  return `${major}.${minor}.${patch}`;
}
