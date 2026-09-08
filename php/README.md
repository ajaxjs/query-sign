# query-sign-php

跨语言一致的请求数据签名（HMAC）库 —— PHP 实现。

同一份数据、同一个密钥，本包与 [npm 版本 `query-sign-node`](https://www.npmjs.com/package/query-sign-node)
产出的签名**逐字节相同**，因此可以放心用于「一端签名、另一端验签」的场景。

[![Packagist Version](https://img.shields.io/packagist/v/ajaxjs/query-sign-php.svg)](https://packagist.org/packages/ajaxjs/query-sign-php)
[![License](https://img.shields.io/packagist/l/ajaxjs/query-sign-php.svg)](./LICENSE)
[![PHP Version Require](https://poser.pugx.org/ajaxjs/query-sign-php/require/php)](https://packagist.org/packages/ajaxjs/query-sign-php)

---

## 特性

- **跨语言一致**：与 Node.js 实现共享同一份规范（[SPEC.md](https://github.com/ajaxjs/query-sign/blob/main/docs/SPEC.md)）和黄金用例集，
  另有随机模糊交叉验证逐字节比对
- **零依赖**：只用 `hash_hmac` / `rawurlencode` 等标准函数，仅要求 `ext-hash`、`ext-json`
- **PSR-4 自动加载**，命名空间 `QuerySign\`
- **嵌套结构自动扁平化**，采用 `a[b][0]=v` 风格的键名
- **确定性强**：与数组键的插入顺序无关，键名按 UTF-8 字节序排序
- **常量时间比较**验签（`hash_equals`），不泄露签名长度以外的信息
- **快速失败**：对象、资源、`NAN`、`INF` 等无法跨语言表示的值一律抛异常，
  绝不静默产出签名
- **浮点数格式化严格复刻 ECMA-262 `Number::toString()`**，与 JS 的 `String(n)` 输出一致

---

## 安装

```bash
composer require ajaxjs/query-sign-php
```

要求 PHP ^7.4 || ^8.0。

没有 Composer 时，本包只依赖 PSR-4 约定，可以自行注册加载器：

```php
spl_autoload_register(static function (string $class): void {
    $prefix = 'QuerySign\\';
    if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
        return;
    }
    $file = __DIR__ . '/vendor/ajaxjs/query-sign-php/src/'
        . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
    if (is_file($file)) {
        require $file;
    }
});
```

---

## 快速开始

```php
<?php

use QuerySign\QuerySign;

$qs = new QuerySign(['secret' => 'my-secret-key']);

$qs->data([
    'appId' => 'wx1234567890',
    'ts'    => 1700000000,
    'nonce' => 'a1b2c3',
    'user'  => ['id' => 7, 'name' => 'tom'],
]);

$qs->getStringToSign();
// => 'appId=wx1234567890&nonce=a1b2c3&ts=1700000000&user%5Bid%5D=7&user%5Bname%5D=tom'

$qs->getSign();
// => 'aca22e904d66fb82b613f97e2867e9e65270d4cde0f9aa62236798d450e50e71'

(string) $qs;                       // 等价于 $qs->toString()
// => 'appId=wx1234567890&nonce=a1b2c3&ts=1700000000&user%5Bid%5D=7&user%5Bname%5D=tom&sign=aca22e904d66fb82b613f97e2867e9e65270d4cde0f9aa62236798d450e50e71'

$qs->sign();
// => ['appId' => 'wx1234567890', 'ts' => 1700000000, 'nonce' => 'a1b2c3',
//     'user' => ['id' => 7, 'name' => 'tom'], 'sign' => 'aca22e90...']

json_encode($qs->sign());
// => {"appId":"wx1234567890","ts":1700000000,"nonce":"a1b2c3","user":{"id":7,"name":"tom"},"sign":"aca22e904d66fb82b613f97e2867e9e65270d4cde0f9aa62236798d450e50e71"}
```

### 服务端验签

```php
$qs = new QuerySign(['secret' => 'my-secret-key']);

// 直接把整个请求参数丢进来即可
$qs->data($_GET);

if (!$qs->verify()) {
    http_response_code(403);
    exit('invalid signature');
}
```

`verify()` 省略参数时会自动从数据里读取 `signField`（默认 `sign`）。
注意：该字段本身**不参与**签名计算，所以无需先把它剔除。

### 与 Node.js 端互验

同样的数据和密钥，Node.js 端产出完全相同的签名：

```js
const qs = new QuerySign({ secret: 'my-secret-key' });
qs.data({
  appId: 'wx1234567890',
  ts: 1700000000,
  nonce: 'a1b2c3',
  user: { id: 7, name: 'tom' },
});

qs.getSign();
// => 'aca22e904d66fb82b613f97e2867e9e65270d4cde0f9aa62236798d450e50e71'
```

---

## API

### `new QuerySign(array $options)`

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `secret` | `string` | — | **必填**，非空字符串。为空时构造即抛 `InvalidArgumentException` |
| `signField` | `string` | `'sign'` | 签名字段名。该字段在顶层被排除，不参与签名 |
| `algorithm` | `string` | `'sha256'` | HMAC 算法。跨端使用请选两端都支持的：`md5` / `sha1` / `sha224` / `sha256` / `sha384` / `sha512` |
| `encoding` | `'hex' \| 'base64'` | `'hex'` | 签名输出编码 |
| `uppercase` | `bool` | `false` | 是否把 `hex` 输出转大写。对 `base64` 静默忽略 |
| `loose` | `bool` | `false` | 仅对 `hex` 生效：验签时忽略大小写（兼容对端返回大写 hex） |

构造时会立即用 `hash_algos()` 校验 `algorithm` 是否被当前运行时支持，不支持则抛异常——
避免等到第一次签名时才失败。

```php
$qs->options();
// => ['secret' => 'my-secret-key', 'signField' => 'sign', 'algorithm' => 'sha256',
//     'encoding' => 'hex', 'uppercase' => false, 'loose' => false]
```

### 实例方法

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `data(?array $data = null)` | `$this` | 设置待签名数据（关联数组或索引数组）；传 `null` 或省略参数表示清空。PHP 数组是值类型，赋值即完成拷贝 |
| `getData()` | `array` | 当前数据的副本 |
| `getStringToSign()` | `string` | 规范化后的待签名字符串。**跨语言排查签名不一致时先看这个** |
| `getSign()` | `string` | 计算并返回签名字符串 |
| `sign()` | `array` | 返回「原始数据 + 签名字段」的新数组，不修改内部数据 |
| `verify($sign = null)` | `bool` | 验签。任何非法输入都返回 `false`，不抛异常 |
| `toString()` | `string` | `key=value&...&sign=签名`，可直接作为 query string |
| `__toString()` | `string` | PHP 习惯用法，`(string) $qs` 等价于 `toString()` |
| `options()` | `array` | 当前生效配置的副本（含默认值） |

### 常量

```php
QuerySign::SPEC_VERSION;       // => 1，规范版本号，跨语言实现必须一致
QuerySign::COMMON_ALGORITHMS;  // => ['md5','sha1','sha224','sha256','sha384','sha512']
```

### 异常

| 异常 | 触发时机 |
| --- | --- |
| `QuerySign\Exception\InvalidArgumentException` | 配置非法、数据含不支持的值类型、`NAN` / `INF`、扁平化后键名冲突 |
| `QuerySign\Exception\ExceptionInterface` | 上述异常的标记接口，可用于一次性捕获本库所有异常 |
| 原生 `\TypeError` | `data()` 收到非数组（如字符串、整数）。由形参类型 `?array` 直接拒绝 |

`InvalidArgumentException` 继承自 SPL 的 `\InvalidArgumentException`，
业务方既可以捕获本类，也可以沿用 `\InvalidArgumentException`：

```php
use QuerySign\Exception\InvalidArgumentException;

try {
    $qs->data(['at' => new DateTime()]);
} catch (InvalidArgumentException $e) {
    // query-sign: 不支持的值类型 object(DateTime) (路径: at)，请先转换为关联数组/索引数组或字符串
}
```

想一网打尽本库异常时，捕获标记接口即可：

```php
use QuerySign\Exception\ExceptionInterface;

try {
    $sign = $qs->getSign();
} catch (ExceptionInterface | \TypeError $e) {
    // ...
}
```

---

## 签名算法

完整规范见 [SPEC.md](https://github.com/ajaxjs/query-sign/blob/main/docs/SPEC.md)，摘要如下：

1. **剔除签名字段** —— 只剔除**顶层**键名严格等于 `signField` 的字段，嵌套层级中的同名字段照常参与
2. **扁平化** —— `['a' => ['b' => [1]]]` → `a[b][0] = 1`；`null` 的键被整体丢弃；空数组不产生任何键
3. **字符串化** —— 布尔转 `true` / `false`（**不是** PHP 默认的 `1` / `''`）；整数直接转；浮点数用最短往返表示；`NAN` / `INF` 抛异常
4. **排序** —— 键名按 **UTF-8 字节**的无符号字典序升序（用 `strcmp` 做二进制安全比较，不是本地 collation）
5. **编码拼接** —— 键和值分别用 `rawurlencode` 编码（空格是 `%20` 而非 `+`），以 `&` 连接
6. **HMAC** —— 对 `stringToSign` 做 `hash_hmac`，按 `encoding` 输出

顶层既可以是关联数组也可以是索引数组。索引数组按下标展开：`[10, 20]` → `0=10&1=20`。

几个容易踩坑但本库已处理好的点：

```php
$qs = new QuerySign(['secret' => 'k']);

// null 被整体丢弃，0 / '' / false 照常参与
$qs->data(['a' => 1, 'b' => null, 'c' => ['d' => null, 'e' => 2], 'f' => [], 'g' => 0, 'h' => '', 'i' => false]);
$qs->getStringToSign();
// => 'a=1&c%5Be%5D=2&g=0&h=&i=false'

// 只有顶层的 sign 被剔除，嵌套的 sign 照常参与
$qs->data(['sign' => 'keep-me', 'x' => ['sign' => 'inner']]);
$qs->getStringToSign();
// => 'x%5Bsign%5D=inner'
```

---

## 注意事项

### 小数一律传字符串

浮点数的十进制表示存在语言/版本差异风险。本库虽然复刻了 ECMA-262 的最短往返表示
（依赖 `serialize_precision = -1`，若运行环境改过该配置，库内部会临时切换并还原），
仍然**强烈建议**把小数当字符串传：

```php
$qs->data(['amount' => '88.88']);   // 推荐
$qs->data(['amount' => 88.88]);     // 可用，但依赖两端浮点格式化完全一致
```

### 不支持的值会抛异常

以下类型无法跨语言一致地表示：

```php
$qs->data(['at' => new DateTime()]);      // ✗ 请自行 ->format(DATE_ATOM)
$qs->data(['id' => $someObject]);         // ✗ 请自行 (array) 或 get_object_vars()
$qs->data(['fh' => fopen(...)]);          // ✗ resource
$qs->data(['n' => NAN]);                  // ✗
```

其中 `DateTime`、自定义对象等在 `data()` 阶段就会被 `normalize()` 拒绝；
`NAN` / `INF` 属于 `float`，会通过 `data()`，在 `getSign()` 时才抛异常。
Node.js 端的时机与此完全一致。

这是刻意设计：静默跳过或 `(string) $value` 会让两端算出不同签名，
而这类问题在线上极难定位。

### 数字键会被 PHP 转成 int

```php
$data = json_decode('{"0":"x","1":"y","2":"z"}', true);
// PHP 得到的是索引数组 [0 => 'x', 1 => 'y', 2 => 'z']，不是关联数组
```

这不是 bug，而是必须支持的场景：同一份 JSON 在 JS 里是对象。
两端都会把它当作列表展开，签名相同：

```php
$qs = new QuerySign(['secret' => 'my-secret-key']);
$qs->data(json_decode('{"0":"x","1":"y","2":"z"}', true));
$qs->getStringToSign();
// => '0=x&1=y&2=z'
$qs->getSign();
// => 'cd9bcc4f7b83320e0bf846d1258ec36c753cbeb45751cad2c85faa8737a1745e'
```

### `sign()` 恒返回关联数组

顶层是索引数组时，追加字符串签名字段后自然变为关联数组：

```php
$qs = new QuerySign(['secret' => 'my-secret-key']);
$qs->data([10, 20]);

$qs->getStringToSign();   // => '0=10&1=20'
$qs->getSign();           // => '10d990bdc1ac924da51e00f473cd16a980e2a3c76e2b0b838e64fce0722f6b36'

json_encode($qs->sign());
// => {"0":10,"1":20,"sign":"10d990bdc1ac924da51e00f473cd16a980e2a3c76e2b0b838e64fce0722f6b36"}
```

与 Node.js 端的 JSON 形态一致。顺带地，`verify()` 在顶层是索引数组时读不到签名字段
（索引数组没有字符串键），因此会返回 `false`——两端行为相同。

### `toString()` 的签名值也做了编码

`hex` 下是恒等变换；`base64` 下会把 `+` `/` `=` 转义，避免破坏 query string：

```php
$qs = new QuerySign(['secret' => 'k', 'encoding' => 'base64']);
$qs->data(['a' => 'x', 'b' => 1, 'c' => ['d' => [1, 2]]]);

$qs->getSign();
// => 'e6u2DDb5kxLyBwzj6aPU1ywvhZ3fMgxH/XC2YijLgQc='

$qs->toString();
// => 'a=x&b=1&c%5Bd%5D%5B0%5D=1&c%5Bd%5D%5B1%5D=2&sign=e6u2DDb5kxLyBwzj6aPU1ywvhZ3fMgxH%2FXC2YijLgQc%3D'
```

`getSign()` 返回的是**未编码**的原始签名值，放进 JSON body 时用这个。

### `uppercase` 与 `loose` 的配合

对端返回大写 hex 时，不必改对方的实现，开 `loose` 即可：

```php
$qs = new QuerySign(['secret' => 'my-secret-key', 'loose' => true]);
$qs->data(['a' => 1, 'sign' => 'BD2EE5E60CD0794933ADF88E60C8D764A2D073B5CE4BC27CE64D66B6EF4D5C34']);

$qs->verify();   // => true（小写形式是 bd2ee5e60cd0794933adf88e60c8d764a2d073b5ce4bc27ce64d66b6ef4d5c34）
```

未开 `loose` 时同一个输入返回 `false`。

### 自定义签名字段名

```php
$qs = new QuerySign(['secret' => 'my-secret-key', 'signField' => 'signature']);
$qs->data(['a' => 1, 'b' => 2]);

json_encode($qs->sign());
// => {"a":1,"b":2,"signature":"5e7316c24a005a818c9a98b0692c437be9577737df3c1ca3d9fbfa08556f88f6"}
```

---

## 开发

本仓库即包根目录（由 monorepo [`ajaxjs/query-sign`](https://github.com/ajaxjs/query-sign)
通过 `git subtree split` 拆分发布）：

```bash
composer install
composer run lint     # 语法检查全部源文件 + composer validate --strict
composer run test     # 跑全部单测与跨语言 fixtures
composer run check    # 以上两步
```

**未执行 `composer install` 也能跑测试**：`tests/bootstrap.php` 在找不到
`vendor/autoload.php` 时会回退到内置的 PSR-4 加载器，测试框架本身也是零依赖自建的
（`tests/Harness.php`）。所以直接：

```bash
php tests/run.php
```

同样可以完整校验。

> `tests/` 与 `scripts/` 在 `.gitattributes` 里标记了 `export-ignore`，因此
> `composer require` 安装的产物不含它们；但 `git clone` 本仓库能拿到完整内容，开发不受影响。

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
