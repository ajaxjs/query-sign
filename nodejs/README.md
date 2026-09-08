# query-sign-node

跨语言一致的请求数据签名（HMAC）库 —— Node.js / TypeScript 实现。

同一份数据、同一个密钥，本包与 [PHP 版本 `ajaxjs/query-sign-php`](https://packagist.org/packages/ajaxjs/query-sign-php)
产出的签名**逐字节相同**，因此可以放心用于「一端签名、另一端验签」的场景。

[![npm version](https://img.shields.io/npm/v/query-sign-node.svg)](https://www.npmjs.com/package/query-sign-node)
[![license](https://img.shields.io/npm/l/query-sign-node.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/query-sign-node.svg)](https://nodejs.org)

---

## 特性

- **跨语言一致**：与 PHP 实现共享同一份规范（[SPEC.md](https://github.com/ajaxjs/query-sign/blob/main/docs/SPEC.md)）和黄金用例集，
  另有随机模糊交叉验证逐字节比对
- **TypeScript 编写**，自带类型声明；同时提供 CJS 与 ESM 双产物
- **零运行时依赖**，只用 `node:crypto`
- **嵌套结构自动扁平化**，采用 `a[b][0]=v` 风格的键名
- **确定性强**：与字段插入顺序无关，键名按 UTF-8 字节序排序
- **常量时间比较**验签（`crypto.timingSafeEqual`），不泄露签名长度以外的信息
- **快速失败**：`Date`、`Map`、类实例、循环引用、`NaN` 等无法跨语言表示的值一律抛错，
  绝不静默产出签名

---

## 安装

```bash
npm install query-sign-node
```

要求 Node.js >= 18。

---

## 快速开始

```js
import { QuerySign } from 'query-sign-node';
// CommonJS: const { QuerySign } = require('query-sign-node');

const qs = new QuerySign({ secret: 'my-secret-key' });

qs.data({
  appId: 'wx1234567890',
  ts: 1700000000,
  nonce: 'a1b2c3',
  user: { id: 7, name: 'tom' },
});

qs.getStringToSign();
// => 'appId=wx1234567890&nonce=a1b2c3&ts=1700000000&user%5Bid%5D=7&user%5Bname%5D=tom'

qs.getSign();
// => 'aca22e904d66fb82b613f97e2867e9e65270d4cde0f9aa62236798d450e50e71'

qs.toString();
// => 'appId=wx1234567890&nonce=a1b2c3&ts=1700000000&user%5Bid%5D=7&user%5Bname%5D=tom&sign=aca22e904d66fb82b613f97e2867e9e65270d4cde0f9aa62236798d450e50e71'

qs.sign();
// => { appId: 'wx1234567890', ts: 1700000000, nonce: 'a1b2c3',
//      user: { id: 7, name: 'tom' }, sign: 'aca22e90...' }
```

### 服务端验签

```js
const qs = new QuerySign({ secret: 'my-secret-key' });

// 请求参数（含 sign 字段）
qs.data(Object.fromEntries(new URLSearchParams(req.url.split('?')[1])));

if (!qs.verify()) {
  res.writeHead(403).end('invalid signature');
}
```

`verify()` 省略参数时会自动从数据里读取 `signField`（默认 `sign`）。
注意：该字段本身**不参与**签名计算，所以可以直接把整个请求参数丢进来。

### 与 PHP 端互验

同样的数据和密钥，PHP 端产出完全相同的签名：

```php
$qs = new QuerySign\QuerySign(['secret' => 'my-secret-key']);
$qs->data([
    'appId' => 'wx1234567890',
    'ts'    => 1700000000,
    'nonce' => 'a1b2c3',
    'user'  => ['id' => 7, 'name' => 'tom'],
]);

$qs->getSign();
// => 'aca22e904d66fb82b613f97e2867e9e65270d4cde0f9aa62236798d450e50e71'
```

---

## API

### `new QuerySign(options)`

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `secret` | `string` | — | **必填**，非空字符串。为空时构造即抛 `TypeError` |
| `signField` | `string` | `'sign'` | 签名字段名。该字段在顶层被排除，不参与签名 |
| `algorithm` | `string` | `'sha256'` | HMAC 算法。跨端使用请选两端都支持的：`md5` / `sha1` / `sha224` / `sha256` / `sha384` / `sha512` |
| `encoding` | `'hex' \| 'base64'` | `'hex'` | 签名输出编码 |
| `uppercase` | `boolean` | `false` | 是否把 `hex` 输出转大写。对 `base64` 静默忽略 |
| `loose` | `boolean` | `false` | 仅对 `hex` 生效：验签时忽略大小写（兼容对端返回大写 hex） |

构造时会立即校验 `algorithm` 是否被当前运行时支持，不支持则抛错——
避免等到第一次签名时才失败。

### 实例方法

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `data(d)` | `this` | 设置待签名数据（对象或数组）；传 `null` / `undefined` 或省略参数表示清空。内部深拷贝，之后修改源对象不影响签名 |
| `getData()` | `object \| array` | 当前数据的深拷贝 |
| `getStringToSign()` | `string` | 规范化后的待签名字符串。**跨语言排查签名不一致时先看这个** |
| `getSign()` | `string` | 计算并返回签名字符串 |
| `sign()` | `object` | 返回「原始数据 + 签名字段」的新对象，不修改内部数据 |
| `verify(sign?)` | `boolean` | 验签。任何非法输入都返回 `false`，不抛错 |
| `toString()` | `string` | `key=value&...&sign=签名`，可直接作为 query string |
| `options` | `object` | 只读的当前生效配置（含默认值） |

### 导出

```ts
import {
  QuerySign,          // 主类（同时也是 default export）
  encodeRfc3986,      // RFC 3986 百分号编码工具
  SPEC_VERSION,       // 规范版本号，跨语言实现必须一致
} from 'query-sign-node';

import type {
  QuerySignOptions,
  ResolvedQuerySignOptions,
  SignableData,
  SignableMap,
  SignableList,
  SignableValue,
  SignableScalar,
  SignAlgorithm,
  SignEncoding,
} from 'query-sign-node';
```

---

## 签名算法

完整规范见 [SPEC.md](https://github.com/ajaxjs/query-sign/blob/main/docs/SPEC.md)，摘要如下：

1. **剔除签名字段** —— 只剔除**顶层**键名严格等于 `signField` 的字段，嵌套层级中的同名字段照常参与
2. **扁平化** —— `{ a: { b: [1] } }` → `a[b][0] = 1`；`null` / `undefined` 的键被整体丢弃；空对象/空数组不产生任何键
3. **字符串化** —— 布尔转 `true` / `false`；数字用最短往返表示；`NaN` / `Infinity` 抛错
4. **排序** —— 键名按 **UTF-8 字节**的无符号字典序升序（不是码点序，也不是本地 collation）
5. **编码拼接** —— 键和值分别做 RFC 3986 编码（空格是 `%20` 而非 `+`），以 `&` 连接
6. **HMAC** —— 对 `stringToSign` 的 UTF-8 字节做 HMAC，按 `encoding` 输出

顶层既可以是对象也可以是数组。数组按下标展开：`[10, 20]` → `0=10&1=20`。

---

## 注意事项

### 小数一律传字符串

浮点数的十进制表示存在语言/版本差异风险。虽然本库两端都实现了「最短往返表示」，
仍然**强烈建议**把小数当字符串传：

```js
qs.data({ amount: '88.88' });   // 推荐
qs.data({ amount: 88.88 });     // 可用，但依赖两端浮点格式化完全一致
```

### 不支持的值会抛错

以下类型无法跨语言一致地表示，`data()` 会立即抛 `TypeError`：

```js
qs.data({ at: new Date() });          // ✗ 请自行 toISOString()
qs.data({ ids: new Set([1, 2]) });    // ✗ 请自行 [...set]
qs.data({ m: new Map() });            // ✗ 请自行 Object.fromEntries(m)
qs.data({ n: NaN });                  // ✗
qs.data({ f: () => {} });             // ✗
```

这是刻意设计：静默跳过或 `String(value)` 会让两端算出不同签名，
而这类问题在线上极难定位。

### `toString()` 的签名值也做了编码

`hex` 下是恒等变换；`base64` 下会把 `+` `/` `=` 转义，避免破坏 query string：

```js
const qs = new QuerySign({ secret: 'k', encoding: 'base64' });
qs.data({ a: 'x', b: 1, c: { d: [1, 2] } });

qs.getSign();
// => 'e6u2DDb5kxLyBwzj6aPU1ywvhZ3fMgxH/XC2YijLgQc='

qs.toString();
// => 'a=x&b=1&c%5Bd%5D%5B0%5D=1&c%5Bd%5D%5B1%5D=2&sign=e6u2DDb5kxLyBwzj6aPU1ywvhZ3fMgxH%2FXC2YijLgQc%3D'
```

`getSign()` 返回的是**未编码**的原始签名值，放进 JSON body 时用这个。

---

## 开发

本仓库即包根目录（由 monorepo [`ajaxjs/query-sign`](https://github.com/ajaxjs/query-sign)
通过 `git subtree split` 拆分发布）：

```bash
npm install
npm run typecheck   # tsc --noEmit（strict，含测试文件）
npm test            # node --test
npm run build       # 产出 dist/cjs + dist/esm + .d.ts
npm run test:dist   # 用构建产物跑一遍跨语言 fixtures
npm run check       # 以上全部
```

跨语言一致性校验需要同时具备 Node 与 PHP 环境，只在 monorepo 根目录提供：

```bash
git clone https://github.com/ajaxjs/query-sign.git
cd query-sign
npm run verify        # 两端构建 + 测试 + 跨语言模糊交叉验证
npm run cross-check   # 只跑模糊交叉验证
```

---

## License

[MIT](./LICENSE)
