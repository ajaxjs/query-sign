# query-sign

跨语言一致的请求数据签名（HMAC）库。

同一份数据、同一个密钥，**不同语言的实现产出的签名逐字节相同**——
一端签名、另一端验签，不需要任何适配层。

| 语言 | 包 | 独立仓库 | 实现 |
| --- | --- | --- | --- |
| Node.js / TypeScript | [`query-sign-node`](https://www.npmjs.com/package/query-sign-node) | [`ajaxjs/query-sign-node`](https://github.com/ajaxjs/query-sign-node) | [`nodejs/`](./nodejs/README.md)，基于 `node:crypto` |
| PHP | [`ajaxjs/query-sign-php`](https://packagist.org/packages/ajaxjs/query-sign-php) | [`ajaxjs/query-sign-php`](https://github.com/ajaxjs/query-sign-php) | [`php/`](./php/README.md)，基于 `hash_hmac` |

本仓库是 **monorepo**，承载跨语言规范（[`docs/SPEC.md`](./docs/SPEC.md)）、共享测试资产
和一键发布脚本；两个语言实现各自拆分为独立仓库，便于独立开发与发布，
内容由本仓库通过 `git subtree split` 同步过去。

---

## 为什么需要它

接口签名看似简单，实际上是跨语言协作中**最容易出错、且出错后最难定位**的一环。
两端各写一遍 `sort + urlencode + hmac`，几乎必然在某个细节上分道扬镳：

- PHP 的 `urlencode` 把空格编成 `+`，JS 的 `encodeURIComponent` 编成 `%20`
- JS 的 `encodeURIComponent` 不编码 `!'()*`，PHP 的 `rawurlencode` 编码
- PHP 默认把 `true` 转成 `"1"`、`false` 转成 `""`，JS 转成 `"true"` / `"false"`
- 排序用码点序还是 UTF-8 字节序，多字节键名下结果不同
- 浮点数的十进制表示，`0.1 + 0.2` 与 `1e21` 各有各的写法
- `json_decode('{"0":"x"}', true)` 在 PHP 里是**列表**，在 JS 里是**对象**

任何一条不一致，表现都是「签名对不上」，而排查往往要跨两个团队、两套日志。

本项目的做法是：**先写规范，再写实现**。
[`docs/SPEC.md`](./docs/SPEC.md) 是唯一的一致性依据，所有语言实现都严格照它执行，
并用共享的黄金用例集与随机模糊测试持续验证。

---

## 快速开始

两端 API 完全等价，下面是同一段逻辑的两种写法。

### Node.js

```js
import { QuerySign } from 'query-sign-node';

const qs = new QuerySign({ secret: 'my-secret-key' });

qs.data({
  appId: 'wx1234567890',
  ts: 1700000000,
  nonce: 'a1b2c3',
  user: { id: 7, name: 'tom' },
});

qs.getSign();
// => 'aca22e904d66fb82b613f97e2867e9e65270d4cde0f9aa62236798d450e50e71'

qs.toString();
// => 'appId=wx1234567890&nonce=a1b2c3&ts=1700000000&user%5Bid%5D=7&user%5Bname%5D=tom&sign=aca22e90...'
```

### PHP

```php
use QuerySign\QuerySign;

$qs = new QuerySign(['secret' => 'my-secret-key']);

$qs->data([
    'appId' => 'wx1234567890',
    'ts'    => 1700000000,
    'nonce' => 'a1b2c3',
    'user'  => ['id' => 7, 'name' => 'tom'],
]);

$qs->getSign();
// => 'aca22e904d66fb82b613f97e2867e9e65270d4cde0f9aa62236798d450e50e71'

(string) $qs;
// => 'appId=wx1234567890&nonce=a1b2c3&ts=1700000000&user%5Bid%5D=7&user%5Bname%5D=tom&sign=aca22e90...'
```

签名完全相同。安装方式、完整 API、各类边界行为的说明见
[nodejs/README.md](./nodejs/README.md) 与 [php/README.md](./php/README.md)。

---

## 统一的 API

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `data(d)` | `this` / `$this` | 设置待签名数据（映射或列表）；传 `null` 或省略参数表示清空。支持链式调用 |
| `getData()` | object / array | 当前数据的深拷贝 |
| `getStringToSign()` | string | 规范化后的待签名字符串。**跨语言排查签名不一致时先看这个** |
| `getSign()` | string | 计算并返回签名字符串 |
| `sign()` | object / array | 返回「原始数据 + 签名字段」的新映射，不修改内部数据 |
| `verify(sign?)` | bool | 验签；`sign` 省略时从数据里读 `signField`。**任何非法输入都返回 `false`，不抛错** |
| `toString()` | string | `key=value&...&sign=签名`，可直接作为 query string |

配置项（两端一致）：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `secret` | — | **必填**，非空字符串 |
| `signField` | `'sign'` | 签名字段名，顶层该字段不参与签名 |
| `algorithm` | `'sha256'` | HMAC 算法，跨端请选 `md5`/`sha1`/`sha224`/`sha256`/`sha384`/`sha512` |
| `encoding` | `'hex'` | `hex` 或 `base64` |
| `uppercase` | `false` | `hex` 输出转大写；对 `base64` 静默忽略 |
| `loose` | `false` | 仅 `hex` 生效：验签时忽略大小写 |

---

## 签名算法

完整规范见 [`docs/SPEC.md`](./docs/SPEC.md)，六步：

1. **剔除签名字段** —— 只剔除**顶层**键名严格等于 `signField` 的字段
2. **扁平化** —— `{ a: { b: [1] } }` → `a[b][0] = 1`；`null` 的键整体丢弃；空对象/空数组不产生键
3. **字符串化** —— 布尔转 `true`/`false`；数字用最短往返表示；`NaN`/`Infinity` 抛错
4. **排序** —— 键名按 **UTF-8 字节**的无符号字典序升序（不是码点序，也不是本地 collation）
5. **编码拼接** —— 键和值分别做 RFC 3986 编码（空格是 `%20`），以 `&` 连接
6. **HMAC** —— 对 `stringToSign` 的 UTF-8 字节做 HMAC，按 `encoding` 输出

顶层既可以是映射也可以是列表：`[10, 20]` → `0=10&1=20`。

### 设计取舍

**不支持的值一律抛错，绝不静默跳过。**
`Date`、`Map`、`Set`、类实例、资源、循环引用、`NaN`、函数——这些无法跨语言一致表示的值
会在 `data()` 或签名阶段抛异常。静默 `String(value)` 会让两端算出不同签名，
而这类问题在线上极难定位，宁可让它当场炸掉。

**小数建议一律传字符串。**
两端都实现了 ECMA-262 的最短往返浮点表示（PHP 侧是手写复刻，不依赖 `php.ini`），
但浮点格式化本身就是高风险区，传字符串最稳。

**验签用常量时间比较。**
Node 侧 `crypto.timingSafeEqual`（按 UTF-8 字节长度判定），PHP 侧 `hash_equals`。

---

## 一致性是怎么保证的

不靠「看起来对」，靠三层机械验证：

### 1. 共享黄金用例集

[`test/fixtures.json`](./test/fixtures.json) 共 **38 例**，覆盖嵌套、列表、
空值、Unicode、特殊字符、base64、大写 hex、自定义 `signField`、顶层列表、
数字键互操作等场景。每例记录 `options` / `data` / `stringToSign` / `sign` / `toString`，
**两端测试各自遍历全部用例逐字段比对**。

fixtures 由 Node 参考实现生成（`npm run fixtures`）。生成时会校验一条规范不变量：
把每个用例的**键顺序整体颠倒**，`stringToSign` 必须完全不变——排序环节写错会当场暴露。
生成之后，两端测试各自遍历比对；PHP 侧跑不过，就说明两端不一致。

### 2. 随机模糊交叉验证

[`test/cross-check.mjs`](./test/cross-check.mjs) 生成随机载荷（含 25% 概率的顶层列表），
同时喂给 Node 实现和 PHP 子进程，**逐字节比对** `stringToSign` / `sign` / `toString`。

```bash
npm run cross-check              # 默认 500 例
node test/cross-check.mjs 2000   # 指定例数
node test/cross-check.mjs 2000 --seed=42   # 固定种子复现失败
```

当前状态：**10000 例随机载荷（5 个种子 × 2000 例）逐字节一致**。

### 3. 规范版本号

两端源码各有 `SPEC_VERSION` 常量，fixtures 里也记录 `specVersion`。
发布脚本会校验三者一致——改了签名行为却忘记重新生成用例，会在预检阶段被拦下。

> 修改任何签名行为都属于 **breaking change**，必须提升规范版本号并同步更新 fixtures。

---

## 目录结构

```
query-sign/                     monorepo → github.com/ajaxjs/query-sign
├── docs/
│   └── SPEC.md                 跨语言签名规范（一致性的唯一依据）
├── nodejs/                     → npm 包 query-sign-node
│   │                             subtree split 到 ajaxjs/query-sign-node
│   ├── src/query-sign.ts       TypeScript 实现（单文件、零相对导入）
│   ├── test/                   node:test 单测 + fixtures 遍历
│   ├── scripts/                构建脚本（CJS/ESM 双产物 + 产物自检）
│   ├── package.json            files 字段限定只发布 dist / README / LICENSE
│   ├── LICENSE                 根 LICENSE 的副本（发布产物只含本子目录）
│   └── README.md               npm 详情页展示这份
├── php/                        → Composer 包 ajaxjs/query-sign-php
│   │                             subtree split 到 ajaxjs/query-sign-php
│   ├── src/QuerySign.php       PHP 实现
│   ├── src/Exception/          异常体系（含标记接口）
│   ├── tests/                  零依赖自建测试框架 + fixtures 遍历
│   ├── scripts/lint.php        语法检查 + composer validate
│   ├── composer.json           PSR-4，命名空间 QuerySign\
│   ├── .gitattributes          export-ignore，避免 dist zip 带上 tests/ 与 scripts/
│   ├── LICENSE                 根 LICENSE 的副本（split 后本目录成为仓库根）
│   └── README.md               Packagist 详情页展示这份
├── test/                       跨语言共享资产（不属于任何一端）
│   ├── fixtures.json           38 例黄金用例
│   ├── generate-fixtures.mjs   重新生成 fixtures
│   ├── cross-check.mjs         模糊交叉验证驱动端
│   └── cross-check.php         模糊交叉验证 PHP 子进程
├── scripts/
│   ├── verify.mjs              全仓库质量校验
│   ├── release.mjs             一键发布（npm + Packagist）
│   └── lib/                    共享工具、版本号与占位符扫描逻辑（均含单测）
├── LICENSE
└── package.json                仓库根，private，仅提供 npm scripts 入口
```

**两端完全隔离**：`nodejs/` 和 `php/` 各自是独立可发布的包，互不引用、互不依赖，
只通过仓库根的 `test/` 共享用例。仓库根刻意**不使用 npm workspaces**，
这样 `nodejs/` 可以独立 `npm install` 与发布。

---

## 开发

要求 Node.js >= 18、PHP >= 7.4。PHP 侧不需要 `composer install`——
测试框架是自建的，`tests/bootstrap.php` 在找不到 `vendor/autoload.php` 时
会回退到内置 PSR-4 加载器。

```bash
npm install --prefix nodejs     # 只有 Node 侧需要装依赖（typescript）

npm run verify                  # ★ 全仓库校验：两端构建 + 测试 + 模糊交叉验证
npm test                        # 两端单测 + 发布脚本自测（不含模糊验证）

npm run test:node               # 仅 Node 单测
npm run test:php                # 仅 PHP 单测
npm run test:scripts            # 仅发布脚本的单测
npm run lint:php                # PHP 语法检查 + composer validate --strict

npm run fixtures                # 重新生成 test/fixtures.json
npm run cross-check             # 仅跑模糊交叉验证
```

`npm run verify` 是发布前的必经关卡，也可以单独跑：

```bash
node scripts/verify.mjs --fuzz=2000    # 指定模糊例数
node scripts/verify.mjs --no-fuzz      # 跳过模糊测试
node scripts/verify.mjs --php=php8.3   # 指定 PHP 可执行文件
```

退出码：`0` 全部通过，`1` 存在失败，`2` 参数错误。

---

## 发布

一键发布脚本位于 [`scripts/release.mjs`](./scripts/release.mjs)：

```bash
node scripts/release.mjs                 # 只做预检 + 全量校验，不发布
node scripts/release.mjs --dry-run       # 额外执行 npm publish --dry-run 预览包内容
node scripts/release.mjs --publish       # 真正发布（会二次确认）
node scripts/release.mjs --bump=patch    # 先升版本号再走完整流程
node scripts/release.mjs --publish --tag --push
```

**默认不发布**，必须显式加 `--publish`。六个阶段：读取清单 → 预检 → 版本号 →
构建测试 → 发布 → 汇总。

两个平台的发布模型根本不同，脚本分别处理：

- **npm** —— `npm publish` 直接上传 `nodejs/` 的 tarball
- **Packagist** —— **没有上传命令**，包由 git 仓库 + tag 驱动。脚本负责校验元数据、
  拆分仓库、打 tag、推送，并在配置了 API Token 时自动建包 / 触发更新

### 两个独立仓库由 subtree split 生成

packagist.org 要求 `composer.json` 位于**仓库根目录**，npm 包也希望仓库根即包根，
而本仓库按语言隔离把它们放在 `nodejs/` 与 `php/` 下。因此两个独立仓库都由
`git subtree split` 从本仓库生成，各自保留子目录的完整提交历史：

```bash
node scripts/release.mjs --publish --split --push \
  --node-remote=https://github.com/ajaxjs/query-sign-node.git \
  --php-remote=https://github.com/ajaxjs/query-sign-php.git
```

`--split` 对两端分别执行 `git subtree split --prefix=nodejs` / `--prefix=php`，
产出 `package.json`（或 `composer.json`）位于根目录的独立历史，并打上
`node-vX.Y.Z` / `php-vX.Y.Z` tag，推送时映射为独立仓库上的 `vX.Y.Z`。

只拆一端也可以，配合 `--only` 使用：`--only=npm --split` 或 `--only=packagist --split`。

Packagist 首次建包需要账号凭证。配置以下环境变量后即可全自动；未配置时脚本会跳过
并提示手动到 <https://packagist.org/packages/submit> 提交仓库地址：

| 环境变量 | 用途 |
| --- | --- |
| `PACKAGIST_USERNAME` | Packagist 用户名 |
| `PACKAGIST_API_TOKEN` | Packagist API Token（账号设置页生成） |
| `NODE_PACKAGE_REMOTE` | 等价于 `--node-remote` |
| `PHP_PACKAGE_REMOTE` | 等价于 `--php-remote` |

脚本先尝试 `create-package` 建包，若包已存在则回落到 `update-package` 触发更新，
因此同一条命令对首发和后续版本都适用。

### 预检会拦住什么

- 占位符残留（见下节）
- 两端 `license` / `version` / `SPEC_VERSION` 不一致
- fixtures 的 `specVersion` 与实现不匹配（改了行为忘记重新生成用例）
- `LICENSE` 缺失，或 `nodejs/LICENSE` / `php/LICENSE` 与根目录副本不一致
- README / SPEC 缺失
- 不是 git 仓库，或工作区有未提交改动（可用 `--force` 忽略）
- 未登录 npm，或 npm 上已存在同版本号
- 加了 `--split` 却没给出对应端的 remote

---

## 包名与仓库映射

<!-- placeholder-doc-start -->
| 位置 | 值 |
| --- | --- |
| monorepo | `ajaxjs/query-sign`（本仓库，根 `package.json` 为 private，不发布） |
| npm 包名 | `query-sign-node` |
| Node 独立仓库 | `ajaxjs/query-sign-node` |
| Composer 包名 | `ajaxjs/query-sign-php` |
| PHP 独立仓库 | `ajaxjs/query-sign-php` |

`query-sign` 仍作为**规范与产品族名**保留在两个地方，不要跟着包名一起改：

- 源码抛错消息的统一前缀 `query-sign:` —— 两端必须逐字节一致，属于跨语言契约
- `test/fixtures.json` 的 `referenceImplementation` 字段

预检会扫描包清单与文档里的旧占位符（`OWNER` / `your-vendor` / `YOUR_VENDOR` /
`your-scope`），命中即拒绝发布。快速核对：

```bash
grep -rn "OWNER\|your-vendor" --include="*.json" --include="*.md" .
```
<!-- placeholder-doc-end -->

上面这一节被 `<!-- placeholder-doc-start -->` / `<!-- placeholder-doc-end -->` 圈了起来，
发布脚本的占位符扫描会跳过它。原因很直接：本节必须**指名道姓**地写出这些 token，
否则替换完成之后它会永远误报。标记是 HTML 注释，Markdown 渲染后不可见。

标记必须**独占一行**才生效，内联提及不会开启豁免——否则解释标记用法的这句话自己
就会把豁免打开且再也关不上，导致文件后半部分的真实占位符全部漏检。

---

## 新增一种语言

1. 通读 [`docs/SPEC.md`](./docs/SPEC.md)——它是唯一依据，不要参考其它语言的实现去猜
2. 新建 `<language>/` 目录，实现第 6 节的全部 API 契约
3. 写一个遍历 `test/fixtures.json` 的测试，**38 例全部逐字段通过**即视为签名一致
4. 仿照 `test/cross-check.php` 写一个子进程入口，接入模糊交叉验证
5. 在 `scripts/verify.mjs` 与 `scripts/release.mjs` 中接入该语言
6. 更新本 README 的语言表格

注意几个几乎必踩的坑（都已在 SPEC 中写明）：
该语言的 URL 编码函数是否符合 RFC 3986、布尔与浮点的默认字符串化行为、
排序用的是码点还是字节、以及 JSON 解析后「数字键对象」会变成什么类型。

---

## License

[MIT](./LICENSE)
