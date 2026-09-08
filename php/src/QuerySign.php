<?php

declare(strict_types=1);

namespace QuerySign;

use QuerySign\Exception\InvalidArgumentException;

/**
 * query-sign —— 跨语言请求签名库 (PHP 实现)
 *
 * 规范化算法严格遵循仓库 docs/SPEC.md (v1)，与 Node.js 实现保持字节级一致。
 *
 * 用法：
 * ```php
 * $qs = new QuerySign(['secret' => 'my-secret']);
 * $qs->data(['appId' => 'a1', 'ts' => 1700000000]);
 *
 * $qs->getSign();    // 签名字符串
 * $qs->sign();       // 原数据 + sign 字段
 * $qs->verify();     // 验签
 * (string) $qs;      // key=value&...&sign=xxx
 * ```
 */
class QuerySign
{
    /** 规范版本号，跨语言实现必须一致 */
    public const SPEC_VERSION = 1;

    /** 两端（Node.js / PHP）都保证支持的 HMAC 算法名 */
    public const COMMON_ALGORITHMS = ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512'];

    private const SUPPORTED_ENCODINGS = ['hex', 'base64'];

    /** @var string */
    private $secret;

    /** @var string */
    private $signField;

    /** @var string */
    private $algorithm;

    /** @var string */
    private $encoding;

    /** @var bool */
    private $uppercase;

    /** @var bool */
    private $loose;

    /** @var array<array-key, mixed> */
    private $data = [];

    /**
     * @param array<string, mixed> $options
     * @phpstan-param array{
     *     secret: string,
     *     signField?: string,
     *     algorithm?: string,
     *     encoding?: 'hex'|'base64',
     *     uppercase?: bool,
     *     loose?: bool
     * } $options
     */
    public function __construct(array $options)
    {
        if (!isset($options['secret']) || !\is_string($options['secret']) || $options['secret'] === '') {
            throw new InvalidArgumentException('query-sign: options.secret 必须是非空字符串');
        }

        $signField = $options['signField'] ?? 'sign';
        if (!\is_string($signField) || $signField === '') {
            throw new InvalidArgumentException('query-sign: options.signField 必须是非空字符串');
        }

        $algorithm = $options['algorithm'] ?? 'sha256';
        if (!\is_string($algorithm) || $algorithm === '') {
            throw new InvalidArgumentException('query-sign: options.algorithm 必须是非空字符串');
        }
        if (!\in_array(strtolower($algorithm), hash_algos(), true)) {
            throw new InvalidArgumentException(sprintf(
                'query-sign: 当前 PHP 不支持 HMAC 算法 "%s"，可用: %s',
                $algorithm,
                implode(', ', self::COMMON_ALGORITHMS)
            ));
        }

        $encoding = $options['encoding'] ?? 'hex';
        if (!\is_string($encoding) || !\in_array($encoding, self::SUPPORTED_ENCODINGS, true)) {
            throw new InvalidArgumentException(sprintf(
                'query-sign: options.encoding 只支持 %s，收到 "%s"',
                implode(' / ', self::SUPPORTED_ENCODINGS),
                \is_scalar($encoding) ? (string) $encoding : \gettype($encoding)
            ));
        }

        $this->secret = $options['secret'];
        $this->signField = $signField;
        // hash_hmac 的算法名不区分大小写，统一转小写以保证行为确定
        $this->algorithm = strtolower($algorithm);
        $this->encoding = $encoding;
        $this->uppercase = ($options['uppercase'] ?? false) === true;
        $this->loose = ($options['loose'] ?? false) === true;
    }

    /**
     * 当前生效的配置副本。
     *
     * @return array<string, mixed>
     */
    public function options(): array
    {
        return [
            'secret' => $this->secret,
            'signField' => $this->signField,
            'algorithm' => $this->algorithm,
            'encoding' => $this->encoding,
            'uppercase' => $this->uppercase,
            'loose' => $this->loose,
        ];
    }

    /**
     * 设置待签名数据。
     *
     * PHP 数组是值类型，赋值即完成深拷贝；这里再做一次归一化以便尽早发现非法值。
     *
     * 顶层既可以是关联数组（映射），也可以是索引数组（列表）。允许列表是为了消除
     * 跨语言歧义：`{"0":"x"}` 这样的 JSON 在 JS 中是对象，在 PHP 中 `json_decode`
     * 会把键转成 int 而成为列表，两端必须产出相同签名。
     *
     * @param array<array-key, mixed>|null $data 传 null（或省略）表示清空
     * @return $this 支持链式调用
     */
    public function data(?array $data = null): self
    {
        if ($data === null) {
            $this->data = [];

            return $this;
        }

        /** @var array<array-key, mixed> $normalized */
        $normalized = $this->normalize($data, '');
        $this->data = $normalized;

        return $this;
    }

    /**
     * 当前数据的副本。
     *
     * @return array<array-key, mixed>
     */
    public function getData(): array
    {
        return $this->data;
    }

    /**
     * 规范化后的待签名字符串（跨语言排查签名不一致时首选看这个）。
     */
    public function getStringToSign(): string
    {
        return implode('&', $this->canonicalPairs());
    }

    /**
     * 计算并返回签名字符串。
     */
    public function getSign(): string
    {
        return $this->hmac(implode('&', $this->canonicalPairs()));
    }

    /**
     * 返回「原始数据 + 签名字段」的新数组，不会修改内部数据。
     *
     * 返回值恒为映射：顶层是索引数组（列表）时，追加字符串签名字段后自然变为
     * 关联数组，即 `[10, 20]` → `[0 => 10, 1 => 20, 'sign' => '...']`，
     * 与 Node.js 端 `{"0":10,"1":20,"sign":"..."}` 的 JSON 形态一致。
     *
     * @return array<array-key, mixed>
     */
    public function sign(): array
    {
        $result = $this->data;
        unset($result[$this->signField]);
        $result[$this->signField] = $this->getSign();

        return $result;
    }

    /**
     * 验签。
     *
     * @param string|null $sign 省略或传 null 时，从当前数据的 signField 中读取
     * @return bool 任何非法输入都返回 false，不抛异常
     */
    public function verify($sign = null): bool
    {
        $actual = $sign;
        if ($actual === null) {
            $actual = $this->data[$this->signField] ?? null;
        }
        if (!\is_string($actual) || $actual === '') {
            return false;
        }

        try {
            $expected = $this->getSign();
        } catch (\Throwable $e) {
            return false;
        }

        if ($this->loose && $this->encoding === 'hex') {
            $actual = strtolower($actual);
            $expected = strtolower($expected);
        }

        return hash_equals($expected, $actual);
    }

    /**
     * 拼接为 `key=value&key=value&sign=签名`，可直接作为 query string 使用。
     *
     * 签名字符串本身也会做 RFC 3986 编码（hex 下是恒等变换，
     * base64 下会转义 `+` `/` `=`）。
     */
    public function toString(): string
    {
        $pairs = $this->canonicalPairs();
        $pairs[] = rawurlencode($this->signField) . '=' . rawurlencode($this->hmac(implode('&', $pairs)));

        return implode('&', $pairs);
    }

    /** PHP 习惯用法：`(string) $qs` 等价于 `$qs->toString()` */
    public function __toString(): string
    {
        return $this->toString();
    }

    /* ------------------------------------------------------------------ *
     * 规范化 (SPEC 3)
     * ------------------------------------------------------------------ */

    /**
     * @return string[] 已按 UTF-8 字节序排好序、且完成 RFC 3986 编码的 `key=value` 片段
     */
    private function canonicalPairs(): array
    {
        $flat = [];
        $this->walk($this->data, '', '', true, $flat);

        // SPEC 3.4：按 UTF-8 字节的无符号字典序升序。
        // strcmp 是二进制安全的字节比较，与 JS 的 Buffer.compare 等价。
        // 注意：PHP 会把纯数字键自动转成 int，这里显式 (string) 转换，
        // 避免在 strict_types 下把 int 传给 strcmp 产生不确定行为。
        uksort($flat, static function ($a, $b): int {
            return strcmp((string) $a, (string) $b);
        });

        $pairs = [];
        foreach ($flat as $key => $value) {
            $pairs[] = rawurlencode((string) $key) . '=' . rawurlencode($value);
        }

        return $pairs;
    }

    /**
     * 递归展开嵌套结构（SPEC 3.2 / 3.3）。
     *
     * @param mixed $value
     * @param array<string, string> $out
     */
    private function walk($value, string $prefix, string $path, bool $isRoot, array &$out): void
    {
        if (!\is_array($value)) {
            throw new InvalidArgumentException($this->unsupportedMessage($value, $path));
        }

        if (self::isList($value)) {
            foreach ($value as $index => $item) {
                if ($item === null) {
                    continue;
                }
                // 顶层列表的根前缀为空串，下标直接作为键名（`0=` 而非 `[0]=`）
                $childKey = $prefix === '' ? (string) $index : $prefix . '[' . $index . ']';
                if (\is_array($item)) {
                    $this->walk($item, $childKey, $childKey, false, $out);
                } else {
                    $str = $this->stringifyScalar($item, $childKey);
                    if ($str !== null) {
                        $this->put($out, $childKey, $str, $childKey);
                    }
                }
            }

            return;
        }

        foreach ($value as $rawKey => $item) {
            $key = (string) $rawKey;

            // SPEC 3.1：仅剔除顶层签名字段，嵌套层级中的同名字段照常参与签名
            if ($isRoot && $key === $this->signField) {
                continue;
            }
            if ($item === null) {
                continue;
            }

            $childKey = $prefix === '' ? $key : $prefix . '[' . $key . ']';
            $childPath = $path === '' ? $key : $path . '.' . $key;

            if (\is_array($item)) {
                $this->walk($item, $childKey, $childPath, false, $out);
            } else {
                $str = $this->stringifyScalar($item, $childPath);
                if ($str !== null) {
                    $this->put($out, $childKey, $str, $childPath);
                }
            }
        }
    }

    /**
     * @param array<string, string> $out
     */
    private function put(array &$out, string $key, string $value, string $path): void
    {
        if (\array_key_exists($key, $out)) {
            throw new InvalidArgumentException(sprintf(
                'query-sign: 扁平化后出现重复键 "%s" (路径: %s)，该数据无法产生确定签名，请调整字段名',
                $key,
                $path
            ));
        }
        $out[$key] = $value;
    }

    /**
     * 标量 → 字符串（SPEC 3.3）。返回 null 表示该键应被整体丢弃。
     *
     * @param mixed $value
     */
    private function stringifyScalar($value, string $path): ?string
    {
        if ($value === null) {
            return null;
        }
        if (\is_string($value)) {
            return $value;
        }
        if (\is_bool($value)) {
            // 必须输出 true/false，禁止使用 PHP 默认的 1/''
            return $value ? 'true' : 'false';
        }
        if (\is_int($value)) {
            return (string) $value;
        }
        if (\is_float($value)) {
            return self::formatFloat($value, $path);
        }

        throw new InvalidArgumentException($this->unsupportedMessage($value, $path));
    }

    /**
     * 浮点数格式化，严格复刻 ECMA-262 `Number::toString(x)` 的十进制输出，
     * 以保证与 Node.js 端 `String(n)` 完全一致。
     */
    private static function formatFloat(float $value, string $path): string
    {
        if (is_nan($value) || is_infinite($value)) {
            throw new InvalidArgumentException(sprintf(
                'query-sign: 数值 %s 不可签名 (路径: %s)',
                is_nan($value) ? 'NaN' : ($value > 0 ? 'Infinity' : '-Infinity'),
                $path
            ));
        }
        if ($value === 0.0 || $value === -0.0) {
            return '0';
        }

        $raw = self::shortestFloatLiteral($value);

        $negative = false;
        if ($raw !== '' && $raw[0] === '-') {
            $negative = true;
            $raw = substr($raw, 1);
        }

        $exponent = 0;
        $ePos = strpos($raw, 'e');
        if ($ePos === false) {
            $ePos = strpos($raw, 'E');
        }
        if ($ePos !== false) {
            $exponent = (int) substr($raw, $ePos + 1);
            $raw = substr($raw, 0, $ePos);
        }

        $dot = strpos($raw, '.');
        $intPart = $dot === false ? $raw : substr($raw, 0, $dot);
        $fracPart = $dot === false ? '' : substr($raw, $dot + 1);

        // 求出 s（最短有效数字）与 n，使 value = 0.s × 10^n
        $all = $intPart . $fracPart;
        $leading = \strlen($all) - \strlen(ltrim($all, '0'));
        $n = \strlen($intPart) - $leading + $exponent;
        $s = rtrim(ltrim($all, '0'), '0');

        if ($s === '') {
            return '0';
        }
        $k = \strlen($s);

        if ($k <= $n && $n <= 21) {
            $rendered = $s . str_repeat('0', $n - $k);
        } elseif ($n > 0 && $n <= 21) {
            $rendered = substr($s, 0, $n) . '.' . substr($s, $n);
        } elseif ($n > -6 && $n <= 0) {
            $rendered = '0.' . str_repeat('0', -$n) . $s;
        } else {
            $e = $n - 1;
            $rendered = $s[0]
                . ($k > 1 ? '.' . substr($s, 1) : '')
                . 'e'
                . ($e >= 0 ? '+' : '-')
                . (string) abs($e);
        }

        return ($negative ? '-' : '') . $rendered;
    }

    /**
     * 取得浮点数的「最短可往返」十进制字面量。
     *
     * 依赖 serialize_precision = -1；若运行环境改过该配置，这里临时切换并在
     * finally 中还原，避免库的输出受 php.ini 影响而与 Node.js 端产生分歧。
     */
    private static function shortestFloatLiteral(float $value): string
    {
        $current = ini_get('serialize_precision');
        if ($current === '-1') {
            $encoded = json_encode($value);

            return \is_string($encoded) ? $encoded : (string) $value;
        }

        @ini_set('serialize_precision', '-1');
        try {
            $encoded = json_encode($value);
        } finally {
            if (\is_string($current)) {
                @ini_set('serialize_precision', $current);
            }
        }

        return \is_string($encoded) ? $encoded : (string) $value;
    }

    /* ------------------------------------------------------------------ *
     * 其它内部工具
     * ------------------------------------------------------------------ */

    /**
     * 深度归一化 + 校验：只允许 数组 / string / int / float / bool / null。
     *
     * @param mixed $value
     * @return mixed
     */
    private function normalize($value, string $path)
    {
        if ($value === null || \is_scalar($value)) {
            return $value;
        }

        if (\is_array($value)) {
            $out = [];
            foreach ($value as $rawKey => $item) {
                $key = (string) $rawKey;
                $out[$key] = $this->normalize($item, $path === '' ? $key : $path . '.' . $key);
            }

            return $out;
        }

        throw new InvalidArgumentException($this->unsupportedMessage($value, $path));
    }

    /**
     * @param mixed $value
     */
    private function unsupportedMessage($value, string $path): string
    {
        return sprintf(
            'query-sign: 不支持的值类型 %s (路径: %s)，请先转换为关联数组/索引数组或字符串',
            self::describeType($value),
            $path === '' ? '<root>' : $path
        );
    }

    /**
     * @param mixed $value
     */
    private static function describeType($value): string
    {
        if (\is_object($value)) {
            return 'object(' . \get_class($value) . ')';
        }

        return \gettype($value);
    }

    /**
     * 是否为索引数组（列表）。空数组返回 true，与 JS 的 `[]` 语义一致。
     *
     * @param array<array-key, mixed> $value
     */
    private static function isList(array $value): bool
    {
        $expected = 0;
        foreach ($value as $key => $_) {
            if ($key !== $expected) {
                return false;
            }
            $expected++;
        }

        return true;
    }

    private function hmac(string $message): string
    {
        if ($this->encoding === 'base64') {
            return base64_encode(hash_hmac($this->algorithm, $message, $this->secret, true));
        }

        $hex = hash_hmac($this->algorithm, $message, $this->secret);

        return $this->uppercase ? strtoupper($hex) : $hex;
    }
}
