/**
 * 跨语言一致性测试：逐条比对仓库根目录 test/fixtures.json 的黄金值。
 *
 * 该文件是 Node.js / PHP（以及未来其它语言）共享的用例集，
 * 任一端产出不同结果即视为签名不一致。
 *
 * 用纯 JS 编写是为了直接复用共享的 test/fixture-utils.mjs。
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { QuerySign, SPEC_VERSION } from '../src/query-sign.ts';
import { assertFixture, loadFixtures } from '../../test/fixture-utils.mjs';

const fixturesFile = fileURLToPath(new URL('../../test/fixtures.json', import.meta.url));
const doc = loadFixtures(fixturesFile);

describe(`跨语言一致性 fixtures（${doc.cases.length} 例，参考实现: ${doc.referenceImplementation}）`, () => {
  it('规范版本号与实现一致', () => {
    assert.equal(doc.specVersion, SPEC_VERSION, 'fixtures 的 specVersion 与 SPEC_VERSION 不匹配，请重新生成');
  });

  for (const fixture of doc.cases) {
    it(fixture.name, () => {
      assertFixture(QuerySign, fixture);
    });
  }
});
