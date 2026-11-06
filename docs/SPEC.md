# query-sign 跨语言签名规范 (v2)

本文档是 `query-sign` 各语言实现的**唯一一致性依据**。任何语言的实现都必须严格遵循本文，
不得有语言特有的隐式行为。若实现与本规范冲突，以本规范为准并修复实现。

---

## 1. 术语

| 术语 | 说明 |
| --- | --- |
| `data` | 待签名的原始数据：映射（JS 对象 / PHP 关联数组）或列表（JS 数组 / PHP 索引数组） |
| `signField` | 签名字段名，默认 `sign` |
| `signMap` | 记录参与签名字段列表的字段名，默认 `sign_map` |
| `sign_map` | `signMap` 选项对应的实际字段（默认即 `sign_map`），值为参与签名的顶层字段名列表 |
| `secret` | 密钥字符串 |
| `stringToSign` | 规范化后的待签名字符串（见第 3 节） |
| `sign` | 对 `stringToSign` 做 HMAC 后的编码结果 |

---

## 2. 配置项 (options)

| 字段 | 类型 | 默认值 | 必填 | 说明 |
| --- | --- | --- | --- | --- |
| `secret` | string | — | **是** | 密钥。必须是非空字符串；为空时构造即抛错 |
| `signField` | string | `sign` | 否 | 签名字段名，不参与签名 |
| `signMap` | string | `sign_map` | 否 | 记录参与签名字段列表的字段名，本身不参与签名 |
| `algorithm` | string | `sha256` | 否 | HMAC 摘要算法：`md5` / `sha1` / `sha256` / `sha512` 等两端都支持的算法 |
| `encoding` | string | `hex` | 否 | 签名输出编码：`hex`（小写十六进制）或 `base64` |
| `uppercase` | bool | `false` | 否 | 是否将 `hex` 输出转为大写。对 `base64` 无效（静默忽略，不抛错） |
| `loose` | bool | `false` | 否 | 仅对 `encoding=hex` 生效：验签时忽略大小写（兼容对端返回大写 hex） |

约束：
1. `signField` 与 `signMap` 都必须是非空字符串，且两者不能相同。
2. `encoding` 只允许 `hex` / `base64`，其它值抛错。
3. `algorithm` 不做白名单校验（交由底层库），但跨端使用时必须选择两端都支持的算法。

---

## 3. `stringToSign` 生成算法（核心）

严格按以下 5 步顺序执行，**每一步都不可省略或调整**：

### 3.1 剔除保留字段与关键字冲突

计算 `stringToSign` 时，顶层字段名**严格等于** `signField` 或 `signMap` 的一律剔除。
（嵌套层级中的同名字段不剔除，照常参与签名。）

此外，**签名入口**（`getStringToSign()` / `getSign()` / `sign()` / `toString()`）
在开始计算前必须检查 `data` 顶层是否已经存在 `signField` / `signMap` 字段：
存在即视为**参数与关键字重叠**，直接抛错，不做静默剔除。

> 这样设计是为了避免「旧签名残留被悄悄忽略」导致的误判。
> 业务方需要改变字段名，或调整 `signField` / `signMap` 来避开冲突。
> 验签入口 `verify()` 不受此限制：它本来就需要在数据中读取 `signField`（签名值）
> 与 `signMap`（字段列表）。

### 3.2 扁平化 (flatten)

把嵌套结构展开为「字符串键 → 标量值」的一层映射，键名采用 PHP `http_build_query` /
`qs` 风格的方括号记法：

| 原始结构 | 扁平化结果 |
| --- | --- |
| `{ a: 1 }` | `a` → `1` |
| `{ a: { b: 1, c: 2 } }` | `a[b]` → `1`，`a[c]` → `2` |
| `{ a: [10, 20] }` | `a[0]` → `10`，`a[1]` → `20` |
| `{ a: { b: [ { c: 1 } ] } }` | `a[b][0][c]` → `1` |

规则：
- 对象（关联数组）用其**键名**作为下标；数组（列表）用其**十进制整数下标**作为下标，下标从 0 开始且**不重排、不压缩**（即保持原始下标）。
- 嵌套深度不限。
- **空对象 / 空数组被整体丢弃**，不产生任何键。
- **顶层既可以是映射，也可以是列表**；顶层为列表时按同样规则展开，
  即根前缀为空串，下标直接作为键名（`[10, 20]` → `0=10&1=20`，**不是** `[0]=10`）。
- 顶层为**标量**（字符串 / 数字 / 布尔）时抛错。

> **为什么顶层允许列表**：`{"0":"x"}` 这样的 JSON 载荷，在 JS 中解析为对象（映射），
> 在 PHP 中 `json_decode(..., true)` 会把键 `"0"` 转成整型，得到 `[0 => "x"]`，
> 即一个列表。两端对同一份 JSON 的类型判定天然不同，若规范禁止顶层列表，
> 这类载荷就无法互操作。允许之后，映射与列表在**任何层级**的展开规则都完全一致，
> 歧义消失。

### 3.3 值的字符串化 (stringify)

对标量值按类型转换，**跨语言必须一致**：

| 类型 | 转换结果 | 备注 |
| --- | --- | --- |
| string | 原样（UTF-8） | 不做 trim、不做大小写变换 |
| integer | 十进制，无前导零、无 `+` | `0` → `"0"`，`-5` → `"-5"` |
| boolean | `"true"` / `"false"` | **PHP 的 `1`/`""` 表示法禁止使用** |
| float / double | 最短往返表示 (shortest round-trip) | 见下方注意事项 |
| null / undefined / nil | **整个键被丢弃** | 不产生 `key=` |
| Date / DateTime 等对象 | **抛错** | 请业务方自行转成字符串（推荐 ISO 8601）后传入 |
| bigint / GMP | 十进制字符串 | JS `String(10n)` 与 PHP `(string)10` 一致 |

**float 注意事项**：必须使用「最短可往返」的十进制表示（JS 的 `String(n)`、
PHP 的 `json_encode()` 在 `serialize_precision = -1` 下的输出、Python 的 `repr()`）。
两端都能得到 `0.1` → `"0.1"`、`1/3` → `"0.3333333333333333"`。
由于浮点表示本身存在语言/版本差异风险，**强烈建议业务方对小数一律传字符串**。
`NaN` / `Infinity` 必须抛错，不允许参与签名。

### 3.4 排序

对所有扁平化后的**键名**按 **UTF-8 字节的无符号字典序升序**排序。

- 不是按 Unicode 码点排序，也不是本地 collation 排序。
- 实现建议：直接比较键名的 UTF-8 字节序列（JS 用 `Buffer.compare`，PHP 用 `strcmp`）。
- 排序稳定，键名唯一，因此结果确定。

### 3.5 编码与拼接

对每个键和值分别做 **RFC 3986 百分号编码**，再以 `key=value` 形式用 `&` 连接：

```
stringToSign = encode(k1) + "=" + encode(v1) + "&" + encode(k2) + "=" + encode(v2) + ...
```

RFC 3986 编码规则：
- **非保留字符（不编码）**：`A-Z` `a-z` `0-9` `-` `_` `.` `~`
- 其它所有字节均编码为 `%XY`，`XY` 为**大写**十六进制
- 空格编码为 `%20`（**不是** `+`）
- 编码作用于字符串的 UTF-8 字节序列

> JS 的 `encodeURIComponent` 不编码 `!'()*`，必须额外补编码才能符合 RFC 3986；
> PHP 用 `rawurlencode`（`urlencode` 会把空格编成 `+`，**禁止使用**）。

### 3.6 示例

```js
data = { b: 2, a: "x y", c: { d: true, e: null } }
```

1. 顶层无保留字段，无需剔除
2. 扁平化 → `b=2`、`a="x y"`、`c[d]=true`（`c[e]` 因 null 被丢弃）
3. 字符串化 → `b:"2"`、`a:"x y"`、`c[d]:"true"`
4. 排序（UTF-8 字节序）→ `a`、`b`、`c[d]`
5. 编码拼接 →

```
a=x%20y&b=2&c%5Bd%5D=true
```

### 3.7 生成 `sign_map` 字段（签名侧）

`sign()` 与 `toString()` 必须在输出中追加 `signMap` 字段（默认 `sign_map`），
值为**参与签名的顶层字段名列表**。`sign_map` 本身不参与 HMAC。

规则：

1. 参与签名的字段 = `data` 的**全部顶层字段**（冲突已在 3.1 抛错，因此没有保留字段）。
   顶层是列表时，字段名即十进制下标 `"0"`、`"1"`……
2. 字段列表顺序与 JS 普通对象的 `Object.keys` 一致：
   **数组下标（规范数字串 `0` ~ `4294967294`）按数值升序排在最前，其余键保持插入顺序**。
   PHP 等语言必须显式实现该顺序，否则同一份数据会产出不同的 `sign_map`。
3. 字段名转义后以 `+` 连接：
   - `%` → `%25`
   - `+` → `%2B`
   - 其余字符原样保留（`name+age` 这类常见输出保持可读）
4. 顶层字段名**不能是空字符串**（空串无法在列表中被无歧义表示），否则抛错。
5. `data` 为空时，`sign_map` 的值为空字符串。

示例：

```js
qs.data({ name: 'kevin', age: 20 }).sign()
// => { name: 'kevin', age: 20, sign_map: 'name+age', sign: '...' }

qs.data({ 'a+b': 1, '100%': 2 }).sign()
// => { 'a+b': 1, '100%': 2, sign_map: 'a%2Bb+100%25', sign: '...' }
```

---

## 4. 签名计算

```
sign = encode_output( HMAC( algorithm, secret, utf8_bytes(stringToSign) ) )
```

- `HMAC` 的 message 是 `stringToSign` 的 UTF-8 字节序列。
- `encode_output`：`hex` → 小写十六进制（`uppercase=true` 时转大写）；`base64` → 标准 Base64（含 `+` `/` `=`，不换行）。

---

## 5. 验签 (verify)

1. 若调用方未显式传入 `sign`，则从当前 `data` 中读取 `data[signField]`；读取不到即返回 `false`。
2. 传入的 `sign` 若非字符串，返回 `false`（不抛错）。
3. **确定验签字段范围**（v2 新增）：
   - 若 `data` 中存在 `signMap` 字段：其值必须是字符串，按 `+` 拆分并解码（`%25` → `%`，`%2B` → `+`）
     得到字段列表，然后：
     - 字段名不得为空、不得是 `signField` / `signMap`、不得重复；
     - 每个字段都必须存在于 `data` 顶层，**缺任何一个都直接抛错**（不是返回 `false`）；
     - 验签时**只**用这些字段重算签名，其它额外字段忽略。
       这允许同一个请求里携带无需签名的参数。
     - `signMap` 值为空字符串表示「没有字段参与签名」，按空数据计算。
   - 若 `data` 中**没有** `signMap` 字段：兼容 v1 行为，用全部顶层字段（排除 `signField` / `signMap`）重算。
4. 用相同的 `secret` / `algorithm` / `encoding` / `uppercase` **重新计算**期望签名。
5. 与传入值做**大小写敏感的定长常量时间比较**：
   - `encoding=hex` 时，允许把待验证值统一转小写后比较（兼容对端返回大写 hex）——
     该行为由 `loose` 选项控制，**默认关闭**，即默认严格区分大小写。
   - `encoding=base64` 时严格逐字符比较。
6. 长度不同直接返回 `false`。

> `verify()` 只在**签名不匹配 / 签名缺失 / 非字符串**时返回 `false`；
> `signMap` 结构错误（非字符串、字段缺失、字段名非法、重复）属于数据不完整，必须抛错，
> 以便调用方区分「伪造签名」与「漏传字段」。

---

## 6. API 契约

所有语言实现必须提供以下等价 API：

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `data(d)` | `this` | 设置待签名数据（映射或列表）；传 `null`/`nil` 或省略参数表示清空。链式调用 |
| `getData()` | object/array | 返回当前数据的**深拷贝**，避免外部修改影响签名 |
| `getSign()` | string | 计算并返回签名字符串 |
| `sign()` | object/array | 返回「原始数据 + sign_map + 签名字段」的**新映射**（不修改原 data） |
| `verify(sign?)` | bool | 验签，见第 5 节 |
| `getStringToSign()` | string | 返回 `stringToSign`，用于跨语言调试 |
| `toString()` | string | 返回 `key=value&...&signMap=字段列表&signField=sign`，见下 |

`getStringToSign()` / `getSign()` / `sign()` / `toString()` 规则：
- 计算前若发现 `data` 顶层已有 `signField` / `signMap` 字段，**抛错**（见 3.1）。
- **返回值恒为映射**（JS 普通对象 / PHP 关联数组）。
- `sign()` 若 `data` 是列表，则先转换为以十进制下标为键的映射再追加字段——
  `[10, 20]` → `{ "0": 10, "1": 20, "sign_map": "0+1", "sign": "..." }`。
  这样做的原因：JS 中给数组附加字符串属性会在 `JSON.stringify` 时被静默丢弃，
  而 PHP 中给列表附加字符串键会得到关联数组，两者必须对齐。
- `sign()` 先写入 `signMap`（见 3.7），再写入 `signField`。
- 不修改内部数据。

`toString()` 规则：
- 内容为**扁平化并编码后**的全部键值对（即 `stringToSign`），再依次追加
  `&encode(signMap)=encode(字段列表)` 与 `&encode(signField)=encode(sign)`。
  两个追加值都要做 RFC 3986 编码：`+` 会变成 `%2B`。签名字符串本身**也要做编码**——
  `hex` 编码后是恒等变换，`base64` 则会把 `+` `/` `=` 转义，避免破坏 query string。
- 当 `stringToSign` 为空字符串时，结果就是 `sign_map=&sign=...`（不带前导 `&`）。
- `toString()` 的输出可直接被 HTTP query string / form-urlencoded 消费。

---

## 7. 错误处理

以下情况必须**抛错**（而不是静默产生签名）：

| 场景 | JS 异常 | PHP 异常 |
| --- | --- | --- |
| `secret` 缺失或为空 | `TypeError` | `QuerySign\Exception\InvalidArgumentException` |
| `data` 顶层是标量（字符串 / 数字 / 布尔） | `TypeError` | 原生 `\TypeError`（`data()` 形参类型为 `?array`） |
| 出现 `NaN` / `Infinity` | `TypeError` | `QuerySign\Exception\InvalidArgumentException` |
| 出现无法序列化的值（资源、循环引用、函数、`Date`、类实例等） | `TypeError` | 同上 |
| 非法的 `encoding` / `signField` / `signMap` | `TypeError` | 同上 |
| `signField` 与 `signMap` 同名 | `TypeError` | 同上 |
| 签名入口发现 `data` 顶层已有 `signField` / `signMap`（参数与关键字重叠） | `TypeError` | 同上 |
| 顶层字段名为空字符串（无法生成 `sign_map`） | `TypeError` | 同上 |
| `verify()` 时 `signMap` 值不是字符串 / 字段名非法 / 重复 | `TypeError` | 同上 |
| `verify()` 时 `signMap` 声明的字段在数据中不存在 | `TypeError` | 同上 |
| 当前运行时不支持所选 `algorithm` | `TypeError`（构造时即抛） | 同上 |
| 扁平化后出现重复键（如 `{a:{b:1}}` 与 `{'a[b]':2}` 并存） | `TypeError` | 同上 |

> PHP 侧「顶层是标量」由语言的原生类型系统拒绝，因此异常类型是 `\TypeError`
> 而非库自定义异常；这与 JS 端抛 `TypeError` 在语义上是对齐的（同为「类型错误」）。
> 跨语言测试用例因此不把该场景放进共享 fixtures，而由各端单元测试分别覆盖。

PHP 侧的 `QuerySign\Exception\InvalidArgumentException` 继承自 SPL 的
`\InvalidArgumentException`，并实现 `QuerySign\Exception\ExceptionInterface` 标记接口，
因此 `catch (\InvalidArgumentException $e)` 同样有效。

`verify()` 对**签名本身**的问题（缺失、非字符串、不匹配）返回 `false`，不抛错；
但 `signMap` 结构错误（非字符串、字段名非法、重复、声明的字段缺失）属于数据不完整，
必须抛错（见第 5 节），以便调用方区分「伪造签名」与「漏传字段」。

---

## 8. 一致性测试

仓库根目录 `test/fixtures.json` 是两端共享的黄金用例集，包含：
`name` / `options` / `data` / `stringToSign` / `sign` / `toString` / `error`。

- 每端测试必须遍历全部 fixture，逐字段比对。
- 新增语言实现时，只要通过全部 fixture，即视为与既有实现签名一致。
- 修改任何签名行为都属于 **breaking change**，必须提升规范版本号并同步更新 fixtures。

> v2 变更：`sign()` / `toString()` 追加 `sign_map` 字段；签名入口禁止与
> `signField` / `signMap` 重名；`verify()` 按 `sign_map` 取字段重算签名。
> `stringToSign` 与 `sign` 值本身不变（`sign_map` 不参与 HMAC），
> 因此 v1 的旧数据仍可通过「无 `sign_map` 时全量验签」的兼容分支验证。
