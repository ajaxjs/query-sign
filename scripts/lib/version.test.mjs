/**
 * scripts/lib/version.mjs 的单元测试。
 *
 * 运行: npm run test:scripts   （等价于 node --test "scripts/lib/*.test.mjs"）
 *
 * 升版本算错属于发布级事故（npm 上的版本无法覆盖），因此单独覆盖。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReleaseError } from './util.mjs';
import { isPlainVersion, isSemver, nextVersion } from './version.mjs';

describe('isPlainVersion / isSemver', () => {
  it('识别纯 x.y.z', () => {
    assert.equal(isPlainVersion('1.0.0'), true);
    assert.equal(isPlainVersion('0.0.1'), true);
    assert.equal(isPlainVersion('1.2.3-beta.1'), false);
    assert.equal(isPlainVersion('1.2'), false);
    assert.equal(isPlainVersion('v1.2.3'), false);
    assert.equal(isPlainVersion(''), false);
    assert.equal(isPlainVersion(undefined), false);
    assert.equal(isPlainVersion(123), false);
  });

  it('识别带预发布/构建元数据的语义化版本', () => {
    assert.equal(isSemver('1.0.0'), true);
    assert.equal(isSemver('1.2.3-beta.1'), true);
    assert.equal(isSemver('1.2.3+build.5'), true);
    assert.equal(isSemver('1.2.3-rc.1+build.5'), true);
    assert.equal(isSemver('1.2'), false);
    assert.equal(isSemver('1.2.3.4'), false);
    assert.equal(isSemver('latest'), false);
  });
});

describe('nextVersion', () => {
  it('patch / minor / major 进位并清零低位', () => {
    assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
    assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
    assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  });

  it('从 0.x 升级不会跳到 1.x', () => {
    assert.equal(nextVersion('0.0.9', 'patch'), '0.0.10');
    assert.equal(nextVersion('0.9.9', 'minor'), '0.10.0');
  });

  it('多位数字版本号不会被截断', () => {
    assert.equal(nextVersion('10.20.30', 'patch'), '10.20.31');
    assert.equal(nextVersion('10.20.30', 'minor'), '10.21.0');
    assert.equal(nextVersion('10.20.30', 'major'), '11.0.0');
  });

  it('预发布版本升 patch 表示转正', () => {
    assert.equal(nextVersion('1.2.3-beta.1', 'patch'), '1.2.3');
    assert.equal(nextVersion('1.2.3-rc.2', 'patch'), '1.2.3');
  });

  it('预发布版本升 minor / major 丢弃预发布后缀', () => {
    assert.equal(nextVersion('1.2.3-beta.1', 'minor'), '1.3.0');
    assert.equal(nextVersion('1.2.3-beta.1', 'major'), '2.0.0');
  });

  it('pre* 级别产出预发布版本', () => {
    assert.equal(nextVersion('1.2.3', 'prepatch'), '1.2.4-0');
    assert.equal(nextVersion('1.2.3', 'preminor'), '1.3.0-0');
    assert.equal(nextVersion('1.2.3', 'premajor'), '2.0.0-0');
  });

  it('level 本身是 x.y.z 时直接采用（不校验是否大于当前版本）', () => {
    assert.equal(nextVersion('1.2.3', '9.9.9'), '9.9.9');
    assert.equal(nextVersion('1.2.3', '1.2.3'), '1.2.3');
  });

  it('非法 level 抛 ReleaseError', () => {
    assert.throws(() => nextVersion('1.2.3', 'huge'), ReleaseError);
    assert.throws(() => nextVersion('1.2.3', ''), ReleaseError);
    assert.throws(() => nextVersion('1.2.3', '1.2'), ReleaseError);
  });

  it('当前版本无法解析时抛 ReleaseError', () => {
    assert.throws(() => nextVersion('v1.2.3', 'patch'), ReleaseError);
    assert.throws(() => nextVersion('', 'patch'), ReleaseError);
    assert.throws(() => nextVersion('1.2', 'patch'), ReleaseError);
  });

  it('错误消息里带上收到的非法值，便于定位', () => {
    assert.throws(
      () => nextVersion('1.2.3', 'huge'),
      (err) => err instanceof ReleaseError && err.message.includes('huge')
    );
    assert.throws(
      () => nextVersion('oops', 'patch'),
      (err) => err instanceof ReleaseError && err.message.includes('oops')
    );
  });
});
