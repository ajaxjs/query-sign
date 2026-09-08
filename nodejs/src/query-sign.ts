/**
 * query-sign —— 跨语言请求签名库 (Node.js / TypeScript 实现)
 *
 * 规范化算法严格遵循仓库 docs/SPEC.md (v1)，与 PHP 实现保持字节级一致。
 * 本文件刻意保持「单文件、零相对导入」，以便同时产出 CJS 与 ESM 两种格式。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * 类型定义
 * ------------------------------------------------------------------ */

/** 规范版本号，跨语言实现必须一致 */
export const SPEC_VERSION = 1;

/** 签名输出编码 */
export type SignEncoding = 'hex' | 'base64';

/**
 * HMAC 摘要算法。
 * 预置常见取值以获得编辑器补全，同时允许任意运行时支持的算法名。
 */
export type SignAlgorithm =
  | 'md5'
  | 'sha1'
  | 'sha224'
  | 'sha256'
  | 'sha384'
  | 'sha512'
  | (string & NonNullable<unknown>);

/** 可参与签名的标量 */
export type SignableScalar = string | number | boolean | bigint;

/** 可参与签名的值 */
export type SignableValue =
  | SignableScalar
  | null
  | undefined
  | SignableMap
  | SignableList;

/** 映射（普通对象 / PHP 关联数组） */
export interface SignableMap {
  [key: string]: SignableValue;
}

/** 列表（数组 / PHP 索引数组） */
export interface SignableList extends Array<SignableValue> {}

/**
 * `data()` 接受的入参：顶层映射或顶层列表。
 *
 * 允许顶层列表是为了消除跨语言歧义：`{"0":"x"}` 在 JS 中是对象，
 * 在 PHP `json_decode(..., true)` 后是列表 `[0 => "x"]`，两者必须产出相同签名。
 */
export type SignableData = SignableMap | SignableList;

/** 构造参数 */
export interface QuerySignOptions {
  /** 密钥，必填且不能为空字符串 */
  secret: string;
  /** 签名字段名，默认 `sign` */
  signField?: string;
  /** HMAC 算法，默认 `sha256` */
  algorithm?: SignAlgorithm;
  /** 签名输出编码，默认 `hex` */
  encoding?: SignEncoding;
  /** `hex` 输出是否转大写，默认 `false`；对 `base64` 静默忽略 */
  uppercase?: boolean;
  /** 验签时是否忽略 `hex` 大小写，默认 `false` */
  loose?: boolean;
}

/** 补全默认值后的配置 */
export interface ResolvedQuerySignOptions {
  secret: string;
  signField: string;
  algorithm: SignAlgorithm;
  encoding: SignEncoding;
  uppercase: boolean;
  loose: boolean;
}

/* ------------------------------------------------------------------ *
 * 常量与基础工具
 * ------------------------------------------------------------------ */

const SUPPORTED_ENCODINGS: readonly SignEncoding[] = ['hex', 'base64'];

const DEFAULT_OPTIONS: Omit<ResolvedQuerySignOptions, 'secret'> = {
  signField: 'sign',
  algorithm: 'sha256',
  encoding: 'hex',
  uppercase: false,
  loose: false,
};

/**
 * RFC 3986 百分号编码（SPEC 3.5）。
 *
 * `encodeURIComponent` 不编码 `!'()*`，这里补齐，
 * 使其输出与 PHP 的 `rawurlencode` 完全一致。
 */
export function encodeRfc3986(input: string): string {
  return encodeURIComponent(input).replace(
    /[!'()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** 是否为「普通对象」：字面量对象、`Object.create(null)`、`JSON.parse` 产物 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isMap(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function describeType(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'symbol') return 'symbol';
  if (value !== null && typeof value === 'object') {
    const ctor = (value as { constructor?: { name?: string } }).constructor;
    const name = ctor && ctor.name;
    return name ? `object(${name})` : 'object';
  }
  return typeof value;
}

function unsupportedValueMessage(value: unknown, path: string): string {
  return (
    `query-sign: 不支持的值类型 ${describeType(value)} (路径: ${path || '<root>'})，` +
    '请先转换为普通对象/数组或字符串'
  );
}

/** 深拷贝；遇到循环引用或不支持的类型直接抛错 */
function deepClone(value: unknown, path: string, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    // function / symbol 的 typeof 也不是 'object'，必须在此显式拒绝，
    // 否则要等到签名阶段才失败，与 PHP 端 data() 立即抛错的行为不一致
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError(unsupportedValueMessage(value, path));
    }
    return value;
  }
  if (seen.has(value)) {
    throw new TypeError(
      `query-sign: 检测到循环引用，无法签名 (路径: ${path || '<root>'})`
    );
  }
  seen.add(value);

  let result: unknown;
  if (isList(value)) {
    const list: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      list[i] = deepClone(value[i], `${path}[${i}]`, seen);
    }
    result = list;
  } else if (isMap(value)) {
    const map: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      map[key] = deepClone(value[key], path ? `${path}[${key}]` : key, seen);
    }
    result = map;
  } else {
    seen.delete(value);
    throw new TypeError(unsupportedValueMessage(value, path));
  }

  seen.delete(value);
  return result;
}

/**
 * 标量 → 字符串（SPEC 3.3）。
 * @returns 返回 `null` 表示该键应被整体丢弃
 */
function stringifyScalar(value: unknown, path: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const type = typeof value;

  if (type === 'string') {
    return value as string;
  }
  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (type === 'number') {
    const num = value as number;
    if (Number.isNaN(num) || !Number.isFinite(num)) {
      throw new TypeError(
        `query-sign: 数值 ${String(num)} 不可签名 (路径: ${path})`
      );
    }
    return String(num);
  }
  if (type === 'bigint') {
    return (value as bigint).toString();
  }

  throw new TypeError(unsupportedValueMessage(value, path));
}

/* ------------------------------------------------------------------ *
 * 扁平化 + 规范化
 * ------------------------------------------------------------------ */

/**
 * 把嵌套结构展开为 `Map<flatKey, stringValue>`（SPEC 3.2 / 3.3）。
 *
 * @param data    顶层映射或顶层列表
 * @param signField 需要在**顶层映射**中剔除的签名字段名
 */
function flatten(
  data: Record<string, unknown> | unknown[],
  signField: string
): Map<string, string> {
  const out = new Map<string, string>();

  const put = (key: string, strValue: string, path: string): void => {
    if (out.has(key)) {
      throw new TypeError(
        `query-sign: 扁平化后出现重复键 "${key}" (路径: ${path})，` +
          '该数据无法产生确定签名，请调整字段名'
      );
    }
    out.set(key, strValue);
  };

  const walk = (
    value: unknown,
    prefix: string,
    path: string,
    isRoot: boolean
  ): void => {
    if (isList(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item === null || item === undefined) continue;
        // 顶层列表的根前缀为空串，下标直接作为键名（`0=` 而非 `[0]=`）
        const childKey = prefix === '' ? String(i) : `${prefix}[${i}]`;
        if (isList(item) || isMap(item)) {
          walk(item, childKey, childKey, false);
        } else {
          const str = stringifyScalar(item, childKey);
          if (str !== null) put(childKey, str, childKey);
        }
      }
      return;
    }

    if (!isMap(value)) {
      throw new TypeError(unsupportedValueMessage(value, path));
    }

    for (const key of Object.keys(value)) {
      // SPEC 3.1：仅剔除顶层签名字段，嵌套层级中的同名字段照常参与签名
      if (isRoot && key === signField) continue;

      const item = value[key];
      if (item === null || item === undefined) continue;

      const childKey = prefix === '' ? key : `${prefix}[${key}]`;
      const childPath = path === '' ? key : `${path}.${key}`;

      if (isList(item) || isMap(item)) {
        walk(item, childKey, childPath, false);
      } else {
        const str = stringifyScalar(item, childPath);
        if (str !== null) put(childKey, str, childPath);
      }
    }
  };

  walk(data, '', '', true);
  return out;
}

/**
 * 按 UTF-8 字节的无符号字典序升序排序（SPEC 3.4）。
 * 预先物化 Buffer，避免比较器内重复分配。
 */
function sortKeysByUtf8Bytes(keys: Iterable<string>): string[] {
  return Array.from(keys, (key) => ({ key, buf: Buffer.from(key, 'utf8') }))
    .sort((a, b) => Buffer.compare(a.buf, b.buf))
    .map((entry) => entry.key);
}

interface CanonicalResult {
  /** 规范化后的待签名字符串 */
  stringToSign: string;
  /** 已编码的 `key=value` 片段，供 `toString()` 复用，避免二次计算 */
  pairs: string[];
}

/** 生成 stringToSign（SPEC 3） */
function buildCanonical(data: SignableData, signField: string): CanonicalResult {
  if (!isMap(data) && !isList(data)) {
    throw new TypeError(
      'query-sign: data 必须是普通对象（关联数组）或数组（列表），顶层不能是标量'
    );
  }

  const flat = flatten(data, signField);
  const pairs: string[] = [];
  for (const key of sortKeysByUtf8Bytes(flat.keys())) {
    pairs.push(`${encodeRfc3986(key)}=${encodeRfc3986(flat.get(key) as string)}`);
  }

  return { stringToSign: pairs.join('&'), pairs };
}

/* ------------------------------------------------------------------ *
 * 主类
 * ------------------------------------------------------------------ */

/**
 * 跨语言一致的请求签名器。
 *
 * @example
 * ```ts
 * import { QuerySign } from 'query-sign';
 *
 * const qs = new QuerySign({ secret: 'my-secret' });
 * qs.data({ appId: 'a1', ts: 1700000000 });
 * qs.getSign();   // => '签名串'
 * qs.toString();  // => 'appId=a1&ts=1700000000&sign=签名串'
 * ```
 */
export class QuerySign {
  readonly #options: ResolvedQuerySignOptions;
  #data: SignableData;

  constructor(options: QuerySignOptions) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('query-sign: options 必须是对象');
    }

    const merged = Object.assign({}, DEFAULT_OPTIONS, options) as ResolvedQuerySignOptions;

    if (typeof merged.secret !== 'string' || merged.secret.length === 0) {
      throw new TypeError('query-sign: options.secret 必须是非空字符串');
    }
    if (typeof merged.signField !== 'string' || merged.signField.length === 0) {
      throw new TypeError('query-sign: options.signField 必须是非空字符串');
    }
    if (typeof merged.algorithm !== 'string' || merged.algorithm.length === 0) {
      throw new TypeError('query-sign: options.algorithm 必须是非空字符串');
    }
    if (SUPPORTED_ENCODINGS.indexOf(merged.encoding) === -1) {
      throw new TypeError(
        `query-sign: options.encoding 只支持 ${SUPPORTED_ENCODINGS.join(' / ')}，收到 "${String(merged.encoding)}"`
      );
    }

    // 提前校验算法可用性，避免运行时才失败
    try {
      createHmac(merged.algorithm, merged.secret);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new TypeError(
        `query-sign: 当前运行时不支持 HMAC 算法 "${merged.algorithm}": ${reason}`
      );
    }

    this.#options = {
      secret: merged.secret,
      signField: merged.signField,
      // 摘要算法名统一归一化为小写，与 PHP 端保持一致（OpenSSL 本身不区分大小写）
      algorithm: merged.algorithm.toLowerCase(),
      encoding: merged.encoding,
      uppercase: merged.uppercase === true,
      loose: merged.loose === true,
    };
    this.#data = {};
  }

  /** 当前生效配置的只读副本 */
  get options(): ResolvedQuerySignOptions {
    return Object.assign({}, this.#options);
  }

  /**
   * 设置待签名数据（内部深拷贝，外部后续修改不会影响签名结果）。
   * @param data 顶层映射或顶层列表；传 `null` / `undefined` 表示清空
   * @returns `this`，支持链式调用
   */
  data(data: SignableData | null | undefined): this {
    if (data === null || data === undefined) {
      this.#data = {};
      return this;
    }
    if (!isMap(data) && !isList(data)) {
      throw new TypeError(
        'query-sign: data 必须是普通对象（映射）或数组（列表），顶层不能是标量'
      );
    }
    this.#data = deepClone(data, '', new WeakSet<object>()) as SignableData;
    return this;
  }

  /** 当前数据的深拷贝 */
  getData(): SignableData {
    return deepClone(this.#data, '', new WeakSet<object>()) as SignableData;
  }

  /** 规范化后的待签名字符串（跨语言排查签名不一致时首选看这个） */
  getStringToSign(): string {
    return buildCanonical(this.#data, this.#options.signField).stringToSign;
  }

  /** 计算并返回签名字符串 */
  getSign(): string {
    const { stringToSign } = buildCanonical(this.#data, this.#options.signField);
    return this.#hmac(stringToSign);
  }

  /**
   * 返回「原始数据 + 签名字段」的**新映射**，不会修改内部数据。
   *
   * 顶层是列表时，会先按十进制下标转为映射再追加签名字段：
   * `[10, 20]` → `{ "0": 10, "1": 20, sign: "..." }`。
   * 原因是 JS 给数组附加字符串属性会在 `JSON.stringify` 时被静默丢弃，
   * 而 PHP 给列表附加字符串键会得到关联数组，两端必须对齐。
   */
  sign(): SignableMap {
    const current = this.getData();
    let result: SignableMap;
    if (isList(current)) {
      result = {};
      for (let i = 0; i < current.length; i++) {
        result[String(i)] = current[i] as SignableValue;
      }
    } else {
      result = current as SignableMap;
    }
    delete result[this.#options.signField];
    result[this.#options.signField] = this.getSign();
    return result;
  }

  /**
   * 验签。
   * @param sign 省略（或传 `null` / `undefined`）时，从当前数据的 `signField` 中读取
   * @returns 是否验证通过；任何非法输入都返回 `false`，不抛错
   */
  verify(sign?: unknown): boolean {
    let actual: unknown = sign;
    if (actual === undefined || actual === null) {
      // 顶层列表不存在字符串键，读不到签名字段，与 PHP 端 `$data[$signField] ?? null` 一致
      actual = isMap(this.#data) ? this.#data[this.#options.signField] : undefined;
    }
    if (typeof actual !== 'string' || actual.length === 0) {
      return false;
    }

    let expected: string;
    try {
      expected = this.getSign();
    } catch {
      return false;
    }

    const { encoding, loose } = this.#options;
    if (loose && encoding === 'hex') {
      actual = (actual as string).toLowerCase();
      expected = expected.toLowerCase();
    }

    // timingSafeEqual 要求两侧字节长度一致；多字节字符可能字符数相同而字节数不同，
    // 因此必须按 UTF-8 字节长度判定，长度不等直接返回 false。
    const actualBuf = Buffer.from(actual as string, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (actualBuf.length !== expectedBuf.length) {
      return false;
    }
    return timingSafeEqual(actualBuf, expectedBuf);
  }

  /**
   * 拼接为 `key=value&key=value&sign=签名`，可直接作为 query string 使用。
   *
   * 签名字符串本身也会做 RFC 3986 编码（`hex` 下是恒等变换，
   * `base64` 下会转义 `+` `/` `=`）。
   */
  toString(): string {
    const { pairs } = buildCanonical(this.#data, this.#options.signField);
    const signValue = this.#hmac(pairs.join('&'));
    pairs.push(
      `${encodeRfc3986(this.#options.signField)}=${encodeRfc3986(signValue)}`
    );
    return pairs.join('&');
  }

  #hmac(message: string): string {
    const { algorithm, secret, encoding, uppercase } = this.#options;
    const digest = createHmac(algorithm, secret).update(message, 'utf8').digest(encoding);
    return encoding === 'hex' && uppercase ? digest.toUpperCase() : digest;
  }
}

export default QuerySign;
