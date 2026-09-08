<?php

declare(strict_types=1);

namespace QuerySign\Tests;

/**
 * 读取仓库根目录 test/fixtures.json（跨语言共享的黄金用例集），
 * 并把其中的「类型标记」解码为 PHP 原生类型。
 *
 * 标记约定与 test/fixture-utils.mjs 保持一致：
 *   {"$float": 2}      -> (float) 2      即 2.0（JS 侧得到 Number 2）
 *   {"$bigint": "123"} -> (string) "123" （PHP 无原生大整数，按十进制字符串传递）
 */
final class FixtureLoader
{
    public const FLOAT_MARKER = '$float';
    public const BIGINT_MARKER = '$bigint';

    private function __construct()
    {
    }

    /** 仓库根目录 */
    public static function repoRoot(): string
    {
        return dirname(__DIR__, 2);
    }

    public static function file(): string
    {
        return self::repoRoot() . '/test/fixtures.json';
    }

    /**
     * @return array{specVersion: int, referenceImplementation: string, cases: array<int, array<string, mixed>>}
     */
    public static function load(): array
    {
        $file = self::file();
        if (!is_file($file)) {
            throw new \RuntimeException('找不到 fixtures 文件: ' . $file . '（请先执行 node test/generate-fixtures.mjs）');
        }

        $raw = file_get_contents($file);
        if ($raw === false) {
            throw new \RuntimeException('无法读取 fixtures 文件: ' . $file);
        }

        /** @var mixed $doc */
        $doc = json_decode($raw, true);
        if (!is_array($doc) || !isset($doc['cases']) || !is_array($doc['cases'])) {
            throw new \RuntimeException('fixtures 文件格式错误: ' . $file . '（缺少 cases 数组）');
        }

        /** @var array{specVersion: int, referenceImplementation: string, cases: array<int, array<string, mixed>>} $doc */
        return $doc;
    }

    /**
     * 把类型标记解码为 PHP 原生值。
     *
     * @param mixed $value
     * @return mixed
     */
    public static function decodeMarkers($value)
    {
        if (!is_array($value)) {
            return $value;
        }

        if (count($value) === 1) {
            if (array_key_exists(self::FLOAT_MARKER, $value)) {
                return (float) $value[self::FLOAT_MARKER];
            }
            if (array_key_exists(self::BIGINT_MARKER, $value)) {
                return (string) $value[self::BIGINT_MARKER];
            }
        }

        $out = [];
        foreach ($value as $key => $item) {
            $out[$key] = self::decodeMarkers($item);
        }

        return $out;
    }
}
