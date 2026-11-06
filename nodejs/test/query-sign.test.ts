/**
 * Node.js 实现的单元测试：覆盖 API 契约、配置校验、异常语义与 JS 特有的类型转换。
 *
 * 跨语言一致性由 test/fixtures.test.mjs 基于共享黄金用例集校验。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QuerySign, SPEC_VERSION, encodeRfc3986 } from '../src/query-sign.ts';
import type { SignableData } from '../src/query-sign.ts';

const SECRET = 'unit-secret';

function make(options: Record<string, unknown> = {}): QuerySign {
  return new QuerySign({ secret: SECRET, ...options });
}

/** 把任意值当作 data 传入，用于测试非法输入必须抛错 */
function anyData(value: unknown): SignableData {
  return value as SignableData;
}

describe('常量与工具', () => {
  it('SPEC_VERSION 为 2', () => {
    assert.equal(SPEC_VERSION, 2);
  });

  it('encodeRfc3986 与 PHP rawurlencode 一致', () => {
    assert.equal(encodeRfc3986('a b'), 'a%20b');
    assert.equal(encodeRfc3986("!'()*"), '%21%27%28%29%2A');
    assert.equal(encodeRfc3986('-_.~'), '-_.~');
    assert.equal(encodeRfc3986('azAZ09'), 'azAZ09');
    assert.equal(encodeRfc3986('中文'), '%E4%B8%AD%E6%96%87');
    assert.equal(encodeRfc3986('+&=%'), '%2B%26%3D%25');
  });

  it('encodeRfc3986 输出统一使用大写十六进制', () => {
    const encoded = encodeRfc3986('\u0001\u007f\u00ff🙂');
    assert.match(encoded, /^(?:%[0-9A-F]{2})+$/u);
  });
});

describe('构造参数校验', () => {
  it('缺少 options 抛 TypeError', () => {
    assert.throws(() => new QuerySign(undefined as unknown as { secret: string }), TypeError);
  });

  it('缺少 secret 抛 TypeError', () => {
    assert.throws(() => new QuerySign({} as { secret: string }), TypeError);
  });

  it('secret 为空串抛 TypeError', () => {
    assert.throws(() => new QuerySign({ secret: '' }), TypeError);
  });

  it('secret 非字符串抛 TypeError', () => {
    assert.throws(() => new QuerySign({ secret: 12345 } as unknown as { secret: string }), TypeError);
  });

  it('signField 为空串抛 TypeError', () => {
    assert.throws(() => make({ signField: '' }), TypeError);
  });

  it('signMap 为空串抛 TypeError', () => {
    assert.throws(() => make({ signMap: '' }), TypeError);
  });

  it('signMap 与 signField 同名抛 TypeError', () => {
    assert.throws(() => make({ signMap: 'sign' }), TypeError);
  });

  it('encoding 非法抛 TypeError', () => {
    assert.throws(() => make({ encoding: 'base32' }), TypeError);
  });

  it('algorithm 不受支持时构造即抛 TypeError', () => {
    assert.throws(() => make({ algorithm: 'not-a-real-algo' }), TypeError);
  });

  it('options 返回补全后的配置副本', () => {
    const qs = make({ algorithm: 'sha1' });
    assert.deepEqual(qs.options, {
      secret: SECRET,
      signField: 'sign',
      signMap: 'sign_map',
      algorithm: 'sha1',
      encoding: 'hex',
      uppercase: false,
      loose: false,
    });
  });

  it('options 副本被修改后不影响实例', () => {
    const qs = make();
    const copy = qs.options as { secret: string };
    copy.secret = 'hacked';
    assert.equal(qs.options.secret, SECRET);
  });

  it('algorithm 大小写不敏感并归一化为小写', () => {
    const upper = make({ algorithm: 'SHA256' });
    const lower = make({ algorithm: 'sha256' });
    upper.data({ a: 1 });
    lower.data({ a: 1 });
    assert.equal(upper.getSign(), lower.getSign());
    assert.equal(upper.options.algorithm, 'sha256');
  });
});

describe('data() 契约', () => {
  it('返回 this 支持链式调用', () => {
    const qs = make();
    assert.equal(qs.data({ a: 1 }), qs);
  });

  it('data(null) / data(undefined) 清空数据', () => {
    const qs = make();
    qs.data({ a: 1 }).data(null);
    assert.deepEqual(qs.getData(), {});
    assert.equal(qs.getStringToSign(), '');

    qs.data({ a: 1 }).data(undefined);
    assert.deepEqual(qs.getData(), {});
  });

  it('默认数据为空对象', () => {
    assert.deepEqual(make().getData(), {});
  });

  it('接受顶层列表，下标直接作为键名', () => {
    const qs = make();
    qs.data([10, 20]);
    assert.equal(qs.getStringToSign(), '0=10&1=20');
  });

  it('顶层列表与等价的数字键映射签名一致（跨语言互操作关键）', () => {
    const list = make();
    list.data([10, 20]);
    const map = make();
    map.data({ '0': 10, '1': 20 });
    assert.equal(list.getSign(), map.getSign());
  });

  it('顶层列表的 sign() 返回映射而非数组', () => {
    const qs = make();
    qs.data([10, 20]);
    const signed = qs.sign();
    assert.equal(Array.isArray(signed), false, 'sign() 必须恒返回映射');
    assert.deepEqual(signed, { '0': 10, '1': 20, sign_map: '0+1', sign: qs.getSign() });
    // JS 给数组附加字符串属性会被 JSON.stringify 静默丢弃，这里确保不会
    assert.equal((JSON.parse(JSON.stringify(signed)) as { sign: string }).sign, qs.getSign());
  });

  it('顶层列表读不到签名字段时 verify() 为 false', () => {
    const qs = make();
    qs.data([10, 20]);
    assert.equal(qs.verify(), false);
    assert.equal(qs.verify(qs.getSign()), true);
  });

  it('顶层标量抛 TypeError', () => {
    assert.throws(() => make().data(anyData('plain-string')), TypeError);
    assert.throws(() => make().data(anyData(42)), TypeError);
    assert.throws(() => make().data(anyData(true)), TypeError);
  });

  it('接受 Object.create(null) 产物', () => {
    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.a = 1;
    const qs = make();
    qs.data(nullProto as SignableData);
    assert.equal(qs.getStringToSign(), 'a=1');
  });

  it('getData() 返回深拷贝，修改副本不影响签名', () => {
    const qs = make();
    qs.data({ a: 1, n: { x: 1 } });
    const before = qs.getSign();

    const copy = qs.getData() as { a: number; n: { x: number } };
    copy.a = 999;
    copy.n.x = 999;

    assert.equal(qs.getSign(), before);
    assert.deepEqual(qs.getData(), { a: 1, n: { x: 1 } });
  });

  it('data() 深拷贝，修改源对象不影响签名', () => {
    const source = { a: 1, nested: { b: 2 } };
    const qs = make();
    qs.data(source);
    const before = qs.getSign();

    source.a = 100;
    source.nested.b = 200;

    assert.equal(qs.getSign(), before);
  });

  it('拒绝 Date 实例', () => {
    assert.throws(() => make().data(anyData({ at: new Date() })), TypeError);
  });

  it('拒绝 Map / Set 实例', () => {
    assert.throws(() => make().data(anyData({ m: new Map() })), TypeError);
    assert.throws(() => make().data(anyData({ s: new Set() })), TypeError);
  });

  it('拒绝类实例', () => {
    class Dto {
      a = 1;
    }
    assert.throws(() => make().data(anyData({ dto: new Dto() })), TypeError);
  });

  it('拒绝函数值', () => {
    assert.throws(() => make().data(anyData({ fn: () => undefined })), TypeError);
  });

  it('拒绝 Symbol 值', () => {
    assert.throws(() => make().data(anyData({ sym: Symbol('x') })), TypeError);
  });

  it('拒绝循环引用', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    assert.throws(() => make().data(anyData(circular)), /循环引用/u);
  });
});

describe('规范化 stringToSign', () => {
  it('null / undefined 丢弃，空串保留', () => {
    const qs = make();
    qs.data({ keep: '', drop: null, gone: undefined, z: 'v' });
    assert.equal(qs.getStringToSign(), 'keep=&z=v');
  });

  it('布尔值归一化为 true/false', () => {
    const qs = make();
    qs.data({ t: true, f: false });
    assert.equal(qs.getStringToSign(), 'f=false&t=true');
  });

  it('嵌套按方括号记法扁平化', () => {
    const qs = make();
    qs.data({ a: { b: { c: 1 } }, l: [10, 20] });
    assert.equal(qs.getStringToSign(), 'a%5Bb%5D%5Bc%5D=1&l%5B0%5D=10&l%5B1%5D=20');
  });

  it('数组中的 null 保留原始下标', () => {
    const qs = make();
    qs.data({ a: [10, null, 20] });
    assert.equal(qs.getStringToSign(), 'a%5B0%5D=10&a%5B2%5D=20');
  });

  it('空容器被整体丢弃', () => {
    const qs = make();
    qs.data({ o: {}, arr: [], real: 'yes', n: { empty: {} } });
    assert.equal(qs.getStringToSign(), 'real=yes');
  });

  it('签名时顶层出现签名字段视为关键字冲突', () => {
    const qs = make();
    qs.data({ a: 1, sign: 'stale' });
    assert.throws(() => qs.getStringToSign(), /关键字重叠/u);
    assert.throws(() => qs.getSign(), /关键字重叠/u);
  });

  it('签名时顶层出现 sign_map 字段视为关键字冲突', () => {
    const qs = make();
    qs.data({ a: 1, sign_map: 'a' });
    assert.throws(() => qs.getSign(), /关键字重叠/u);
  });

  it('嵌套签名字段照常参与签名', () => {
    const qs = make();
    qs.data({ a: 1, meta: { sign: 'inner' } });
    assert.equal(qs.getStringToSign(), 'a=1&meta%5Bsign%5D=inner');
  });

  it('自定义 signField 后同名字段才算冲突', () => {
    const qs = make({ signField: 'signature' });
    qs.data({ a: 1, sign: 'kept' });
    assert.equal(qs.getStringToSign(), 'a=1&sign=kept');
  });

  it('RFC 3986：空格编为 %20，~ 不编码', () => {
    const qs = make();
    qs.data({ sp: 'a b', ti: 'a~b', pl: 'a+b' });
    assert.equal(qs.getStringToSign(), 'pl=a%2Bb&sp=a%20b&ti=a~b');
  });

  it("RFC 3986：!'()* 均需转义", () => {
    const qs = make();
    qs.data({ v: `!"'()*` });
    assert.equal(qs.getStringToSign(), 'v=%21%22%27%28%29%2A');
  });

  it('键插入顺序不影响签名', () => {
    const a = make();
    const b = make();
    a.data({ a: 1, b: 2, c: 3 });
    b.data({ c: 3, b: 2, a: 1 });
    assert.equal(a.getSign(), b.getSign());
    assert.equal(a.getStringToSign(), b.getStringToSign());
  });

  it('按 UTF-8 字节排序，而非 UTF-16 码元排序', () => {
    const qs = make();
    // U+FFFF 的 UTF-8 字节 (EF BF BF) 小于 emoji (F0 9F 99 82)，UTF-16 码元顺序则相反
    qs.data({ '\u{1F642}': 'emoji', '\uFFFF': 'private-use' });
    assert.equal(qs.getStringToSign(), '%EF%BF%BF=private-use&%F0%9F%99%82=emoji');
  });

  it('数字样式的键按字符串字节序排序', () => {
    const qs = make();
    qs.data({ 10: 'a', 9: 'b', 1: 'c', 100: 'd' });
    assert.equal(qs.getStringToSign(), '1=c&10=a&100=d&9=b');
  });

  it('扁平化后重复键抛 TypeError', () => {
    const qs = make();
    qs.data({ 'a[b]': 'scalar', a: { b: 'nested' } });
    assert.throws(() => qs.getSign(), TypeError);
  });

  it('NAN / Infinity 抛 TypeError', () => {
    const nan = make();
    nan.data({ v: Number.NaN });
    assert.throws(() => nan.getSign(), TypeError);

    const inf = make();
    inf.data({ v: Number.POSITIVE_INFINITY });
    assert.throws(() => inf.getSign(), TypeError);
  });

  it('bigint 按十进制字符串参与签名', () => {
    const qs = make();
    qs.data({ big: 12345678901234567890123n, normal: 1 });
    assert.equal(qs.getStringToSign(), 'big=12345678901234567890123&normal=1');
  });
});

describe('数值格式化', () => {
  const cases: Array<[number | string, string]> = [
    [2, '2'],
    [100, '100'],
    [120000, '120000'],
    [0, '0'],
    [-0, '0'],
    [0.1, '0.1'],
    [1 / 3, '0.3333333333333333'],
    [1e-6, '0.000001'],
    [1e-7, '1e-7'],
    [-1.5e-7, '-1.5e-7'],
    [1e20, '100000000000000000000'],
    [1e21, '1e+21'],
    [9007199254740992, '9007199254740992'],
    [-5, '-5'],
    [1.5, '1.5'],
    [-0.5, '-0.5'],
    ['1.20', '1.20'],
  ];

  for (const [input, expected] of cases) {
    it(`${String(input)} => ${expected}`, () => {
      const qs = make();
      qs.data({ v: input as number | string });
      // getStringToSign() 会做 RFC 3986 编码（1e+21 -> 1e%2B21），解码后比对
      assert.equal(decodeURIComponent(qs.getStringToSign()), `v=${expected}`);
    });
  }

  it('字符串数值原样保留，不做数字化处理', () => {
    const qs = make();
    qs.data({ amount: '88.80', zero: '007' });
    assert.equal(qs.getStringToSign(), 'amount=88.80&zero=007');
  });
});

describe('getSign() / sign() / verify()', () => {
  it('getSign() 幂等，且不因其它方法调用而改变', () => {
    const qs = make();
    qs.data({ b: 2, a: 1 });

    const first = qs.getSign();
    qs.toString();
    qs.sign();
    qs.getStringToSign();

    assert.equal(qs.getSign(), first);
  });

  it('sign() 返回原数据 + 签名字段', () => {
    const qs = make();
    qs.data({ a: 1, n: { b: 2 } });
    const signed = qs.sign();

    assert.equal(signed.a, 1);
    assert.deepEqual(signed.n, { b: 2 });
    assert.equal(signed.sign_map, 'a+n');
    assert.equal(signed.sign, qs.getSign());
  });

  it('sign() 遇到关键字冲突直接抛 TypeError', () => {
    const qs = make();
    qs.data({ a: 1, sign: 'stale-value' });
    assert.throws(() => qs.sign(), /关键字重叠/u);

    const withMap = make();
    withMap.data({ a: 1, sign_map: 'a' });
    assert.throws(() => withMap.sign(), /关键字重叠/u);
  });

  it('sign_map 字段名可自定义', () => {
    const qs = make({ signMap: 'signed_fields' });
    qs.data({ a: 1, b: 2 });
    assert.equal(qs.sign().signed_fields, 'a+b');
  });

  it('sign_map 中的 % 与 + 会被转义', () => {
    const qs = make();
    qs.data({ 'a+b': 1, '100%': 2, name: 'kevin' });
    assert.equal(qs.sign().sign_map, 'a%2Bb+100%25+name');
  });

  it('sign() 的字段列表与 JS 对象键序一致（数字键在前）', () => {
    const qs = make();
    qs.data({ b: 2, 10: 'a', a: 1 });
    assert.equal(qs.sign().sign_map, '10+b+a');
  });

  it('sign() 不修改内部数据', () => {
    const qs = make();
    qs.data({ a: 1 });
    qs.sign();
    assert.deepEqual(qs.getData(), { a: 1 });
  });

  it('sign() 使用自定义 signField', () => {
    const qs = make({ signField: 'signature' });
    qs.data({ a: 1 });
    const signed = qs.sign();
    assert.ok('signature' in signed);
    assert.ok(!('sign' in signed));
    assert.equal(signed.sign_map, 'a');
  });

  it('verify() 省略参数时从数据中读取', () => {
    const qs = make();
    qs.data({ a: 1 });
    const sign = qs.getSign();

    qs.data({ a: 1, sign });
    assert.equal(qs.verify(), true);
  });

  it('verify() 显式传参优先于数据', () => {
    const qs = make();
    qs.data({ a: 1 });
    assert.equal(qs.verify(qs.getSign()), true);
  });

  it('verify() 数据被篡改后返回 false', () => {
    const qs = make();
    qs.data({ a: 1 });
    const sign = qs.getSign();

    qs.data({ a: 2, sign });
    assert.equal(qs.verify(), false);
  });

  it('verify() 缺少签名字段返回 false', () => {
    const qs = make();
    qs.data({ a: 1 });
    assert.equal(qs.verify(), false);
  });

  it('verify() 按 sign_map 取字段，忽略未签名的额外字段', () => {
    const qs = make();
    qs.data({ name: 'kevin', age: 20 });
    const sign = qs.getSign();

    qs.data({ name: 'kevin', age: 20, sign_map: 'name+age', extra: 'unsigned', sign });
    assert.equal(qs.verify(), true);
  });

  it('verify() sign_map 声明的字段在数据中缺失时抛 TypeError', () => {
    const qs = make();
    qs.data({ name: 'kevin', sign_map: 'name+age', sign: 'x'.repeat(64) });
    assert.throws(() => qs.verify(), /"age" 在数据中不存在/u);
  });

  it('verify() sign_map 字段非字符串时抛 TypeError', () => {
    const qs = make();
    qs.data({ name: 'kevin', sign_map: ['name'], sign: 'x'.repeat(64) });
    assert.throws(() => qs.verify(), /必须是字符串/u);
  });

  it('verify() sign_map 声明的保留字段抛出 TypeError', () => {
    const qs = make();
    qs.data({ name: 'kevin', sign_map: 'sign', sign: 'x'.repeat(64) });
    assert.throws(() => qs.verify(), /不能声明保留字段/u);
  });

  it('verify() 按 sign_map 取值后签名被篡改返回 false', () => {
    const qs = make();
    qs.data({ name: 'kevin', age: 20 });
    const sign = qs.getSign();

    qs.data({ name: 'kevin2', age: 20, sign_map: 'name+age', sign });
    assert.equal(qs.verify(), false);
  });

  it('verify() 没有 sign_map 时保持旧的全量验签行为', () => {
    const qs = make();
    qs.data({ a: 1 });
    const sign = qs.getSign();
    qs.data({ a: 1, sign });
    assert.equal(qs.verify(), true);
  });

  it('verify() 从 sign() 结果直接验签', () => {
    const qs = make();
    const signed = qs.data({ name: 'kevin', age: 20 }).sign();
    assert.equal(qs.data(signed).verify(), true);
  });

  it('verify() 对非法输入返回 false 且不抛错', () => {
    const qs = make();
    qs.data({ a: 1 });
    assert.equal(qs.verify(123), false);
    assert.equal(qs.verify({}), false);
    assert.equal(qs.verify(true), false);
    assert.equal(qs.verify(''), false);
    assert.equal(qs.verify([]), false);
  });

  it('verify() 对长度不同的输入返回 false', () => {
    const qs = make();
    qs.data({ a: 1 });
    assert.equal(qs.verify('short'), false);
    assert.equal(qs.verify('0'.repeat(512)), false);
  });

  it('verify() 对字符数相同但字节数不同的输入不抛错', () => {
    const qs = make();
    qs.data({ a: 1 });
    // 64 个多字节字符：字符数与 sha256 hex 相同，但 UTF-8 字节数是 192
    assert.equal(qs.verify('密'.repeat(64)), false);
  });

  it('严格模式下大写 hex 验签失败', () => {
    const qs = make();
    qs.data({ a: 1 });
    assert.equal(qs.verify(qs.getSign().toUpperCase()), false);
  });

  it('loose 模式下大写 hex 验签通过', () => {
    const qs = make({ loose: true });
    qs.data({ a: 1 });
    assert.equal(qs.verify(qs.getSign().toUpperCase()), true);
    assert.equal(qs.verify(qs.getSign().toLowerCase()), true);
  });

  it('loose 模式不影响 base64 编码', () => {
    const qs = make({ encoding: 'base64', loose: true });
    qs.data({ a: 1 });
    assert.equal(qs.verify(qs.getSign()), true);
    assert.equal(qs.verify(qs.getSign().toUpperCase() + 'x'), false);
  });

  it('不同算法产出不同签名且长度符合预期', () => {
    const lengths: Record<string, number> = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };
    const signs = new Set<string>();

    for (const [algorithm, length] of Object.entries(lengths)) {
      const qs = make({ algorithm });
      qs.data({ a: 1 });
      const sign = qs.getSign();
      assert.equal(sign.length, length, `${algorithm} 长度应为 ${length}`);
      signs.add(sign);
    }
    assert.equal(signs.size, 4);
  });

  it('uppercase 输出大写 hex', () => {
    const qs = make({ uppercase: true });
    qs.data({ a: 1 });
    const sign = qs.getSign();
    assert.equal(sign, sign.toUpperCase());
    assert.equal(sign.length, 64);
  });

  it('uppercase 对 base64 静默忽略', () => {
    const plain = make({ encoding: 'base64' });
    const upper = make({ encoding: 'base64', uppercase: true });
    plain.data({ a: 1 });
    upper.data({ a: 1 });
    assert.equal(plain.getSign(), upper.getSign());
  });

  it('不同 secret 产生不同签名', () => {
    const a = new QuerySign({ secret: 'secret-a' });
    const b = new QuerySign({ secret: 'secret-b' });
    a.data({ x: 1 });
    b.data({ x: 1 });
    assert.notEqual(a.getSign(), b.getSign());
  });

  it('getSign() 结果与手工 HMAC 一致', async () => {
    const { createHmac } = await import('node:crypto');
    const qs = make();
    qs.data({ a: 1, b: 'x y' });
    const expected = createHmac('sha256', SECRET).update('a=1&b=x%20y', 'utf8').digest('hex');
    assert.equal(qs.getSign(), expected);
  });
});

describe('toString()', () => {
  it('拼接格式为 key=value&...&sign_map=字段列表&sign=签名', () => {
    const qs = make();
    qs.data({ b: 2, a: 1 });
    assert.equal(qs.toString(), `a=1&b=2&sign_map=b%2Ba&sign=${qs.getSign()}`);
  });

  it('空数据时 sign_map 为空串且无前导 &', () => {
    const qs = make();
    qs.data({});
    assert.equal(qs.toString(), `sign_map=&sign=${qs.getSign()}`);
  });

  it('数据中原有的 sign 会被视为关键字冲突', () => {
    const qs = make();
    qs.data({ a: 1, sign: 'stale' });
    assert.throws(() => qs.toString(), /关键字重叠/u);
  });

  it('自定义 signField 后 sign_map 与签名都出现在末尾', () => {
    const qs = make({ signField: 'signature' });
    qs.data({ a: 1 });
    assert.equal(qs.toString(), `a=1&sign_map=a&signature=${qs.getSign()}`);
  });

  it('base64 签名被正确转义', () => {
    const qs = make({ encoding: 'base64' });
    qs.data({ a: 'x', b: 1, c: { d: [1, 2] } });

    const sign = qs.getSign();
    const str = qs.toString();

    assert.equal(str.endsWith(`sign=${encodeRfc3986(sign)}`), true);
    if (/[+/=]/.test(sign)) {
      assert.equal(str.includes(`sign=${sign}`), false, 'base64 原始签名不应直接出现');
    }
  });

  it('结果可被 URLSearchParams 还原', () => {
    const qs = make();
    qs.data({ name: '张三', tags: ['a', 'b'], ok: true });

    const params = new URLSearchParams(qs.toString());
    assert.equal(params.get('name'), '张三');
    assert.equal(params.get('tags[0]'), 'a');
    assert.equal(params.get('tags[1]'), 'b');
    assert.equal(params.get('ok'), 'true');
    assert.equal(params.get('sign_map'), 'name+tags+ok');
    assert.equal(params.get('sign'), qs.getSign());
  });

  it('模板字符串隐式调用 toString()', () => {
    const qs = make();
    qs.data({ a: 1 });
    assert.equal(`${qs}`, qs.toString());
  });
});
