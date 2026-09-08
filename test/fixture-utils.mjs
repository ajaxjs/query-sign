/**
 * 跨语言共享的 fixture 工具（纯 ESM JS，供 Node 测试与产物校验复用）。
 *
 * fixtures.json 中允许出现「类型标记」，用来表达 JSON 本身无法区分的语言类型：
 *   { "$float": 2 }     -> JS: 2        PHP: (float) 2  => 2.0
 *   { "$bigint": "123" }-> JS: 123n     PHP: "123"（十进制字符串，PHP 无原生大整数）
 * 其余 JSON 值按原样传递（整数在 PHP 中自然解析为 int）。
 */

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

export const FLOAT_MARKER = '$float';
export const BIGINT_MARKER = '$bigint';

/** 读取 fixtures.json */
export function loadFixtures(file) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(doc.cases)) {
    throw new Error(`fixtures 格式错误: ${file} 缺少 cases 数组`);
  }
  return doc;
}

/**
 * 把 fixture 中的类型标记解码为 JS 原生值。
 * @param {unknown} value
 * @returns {unknown}
 */
export function decodeMarkers(value) {
  if (Array.isArray(value)) {
    return value.map(decodeMarkers);
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      if (keys[0] === FLOAT_MARKER) {
        return Number(value[FLOAT_MARKER]);
      }
      if (keys[0] === BIGINT_MARKER) {
        return BigInt(value[BIGINT_MARKER]);
      }
    }
    const out = {};
    for (const key of keys) out[key] = decodeMarkers(value[key]);
    return out;
  }
  return value;
}

/** 用 fixture.options 构造实例；构造本身失败也按 throws 语义处理 */
function instantiate(QuerySignClass, fixture) {
  const instance = new QuerySignClass(fixture.options);
  instance.data(decodeMarkers(fixture.data));
  return instance;
}

/**
 * 断言单个 fixture 与实现一致。失败抛 AssertionError。
 *
 * 只比对跨语言必须严格一致的三项：stringToSign / sign / toString。
 * `sign()` 的返回形态属于各语言习惯，由各端单元测试自行覆盖。
 *
 * @param {Function} QuerySignClass
 * @param {object} fixture
 */
export function assertFixture(QuerySignClass, fixture) {
  const label = `[${fixture.name}]`;

  if (fixture.throws) {
    assert.throws(
      () => instantiate(QuerySignClass, fixture).getSign(),
      (err) => err instanceof TypeError,
      `${label} 期望抛出 TypeError 但没有`
    );
    return;
  }

  const qs = instantiate(QuerySignClass, fixture);
  const expect = fixture.expect;

  assert.equal(qs.getStringToSign(), expect.stringToSign, `${label} stringToSign 不一致`);
  assert.equal(qs.getSign(), expect.sign, `${label} sign 不一致`);
  assert.equal(qs.toString(), expect.toString, `${label} toString 不一致`);

  // 显式传入签名时必须通过
  assert.equal(qs.verify(expect.sign), true, `${label} verify(sign) 应为 true`);

  // 篡改最后一位必须失败
  const tampered = expect.sign.slice(0, -1) + (expect.sign.slice(-1) === '0' ? '1' : '0');
  assert.equal(qs.verify(tampered), false, `${label} 篡改签名后 verify 应为 false`);

  // 省略参数时必须从 data[signField] 读取
  const signField = fixture.options.signField || 'sign';
  const withSign = new QuerySignClass(fixture.options);
  withSign.data(Object.assign({}, decodeMarkers(fixture.data), { [signField]: expect.sign }));
  assert.equal(withSign.verify(), true, `${label} verify() 从数据读取应为 true`);
  assert.equal(withSign.verify(tampered), false, `${label} 数据中的签名被篡改后应为 false`);
  assert.equal(qs.verify(), false, `${label} 数据中无签名字段时 verify() 应为 false`);
}

/**
 * 批量执行，返回失败明细（不抛错），便于脚本汇总。
 *
 * @param {Function} QuerySignClass
 * @param {object[]} cases
 * @returns {{passed: number, failures: string[]}}
 */
export function runFixtures(QuerySignClass, cases) {
  const failures = [];
  let passed = 0;
  for (const fixture of cases) {
    try {
      assertFixture(QuerySignClass, fixture);
      passed++;
    } catch (err) {
      failures.push(`${fixture.name}: ${err.message}`);
    }
  }
  return { passed, failures };
}
