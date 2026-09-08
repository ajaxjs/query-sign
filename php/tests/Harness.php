<?php

declare(strict_types=1);

namespace QuerySign\Tests;

/**
 * 极简测试运行器（零依赖）。
 *
 * 之所以不直接用 PHPUnit：本仓库要求 `php tests/run.php` 在未执行
 * `composer install` 的干净环境下也能跑通跨语言一致性校验。
 */
final class Harness
{
    /** @var int */
    private static $passed = 0;

    /** @var int */
    private static $skipped = 0;

    /** @var array<int, array{0: string, 1: string}> */
    private static $failures = [];

    /** @var string|null */
    private static $filter = null;

    /** @var bool */
    private static $colors = true;

    private function __construct()
    {
    }

    /** 关闭 ANSI 着色（终端不支持 VT 序列时使用，也可通过 NO_COLOR 环境变量控制） */
    public static function setColors(bool $enabled): void
    {
        self::$colors = $enabled;
    }

    private static function paint(string $text, string $code): string
    {
        return self::$colors ? "\033[" . $code . 'm' . $text . "\033[0m" : $text;
    }

    public static function setFilter(?string $filter): void
    {
        self::$filter = $filter === null || $filter === '' ? null : $filter;
    }

    public static function group(string $name): void
    {
        echo PHP_EOL . self::paint($name, '1') . PHP_EOL;
    }

    public static function test(string $name, callable $fn): void
    {
        if (self::$filter !== null && stripos($name, self::$filter) === false) {
            self::$skipped++;

            return;
        }

        try {
            $fn();
            self::$passed++;
            echo '  ' . self::paint('✓', '32') . ' ' . $name . PHP_EOL;
        } catch (AssertionFailed $e) {
            self::recordFailure($name, $e->getMessage());
        } catch (\Throwable $e) {
            self::recordFailure(
                $name,
                sprintf('未预期的 %s: %s (%s:%d)', get_class($e), $e->getMessage(), $e->getFile(), $e->getLine())
            );
        }
    }

    private static function recordFailure(string $name, string $message): void
    {
        self::$failures[] = [$name, $message];
        echo '  ' . self::paint('✗', '31') . ' ' . $name . PHP_EOL;
    }

    /* ------------------------- 断言 ------------------------- */

    /**
     * @param mixed $expected
     * @param mixed $actual
     */
    public static function assertSame($expected, $actual, string $message = ''): void
    {
        if ($expected !== $actual) {
            throw new AssertionFailed(self::decorate(
                $message,
                sprintf('期望 %s，实际 %s', self::export($expected), self::export($actual))
            ));
        }
    }

    /**
     * @param mixed $value
     */
    public static function assertTrue($value, string $message = ''): void
    {
        if ($value !== true) {
            throw new AssertionFailed(self::decorate($message, '期望 true，实际 ' . self::export($value)));
        }
    }

    /**
     * @param mixed $value
     */
    public static function assertFalse($value, string $message = ''): void
    {
        if ($value !== false) {
            throw new AssertionFailed(self::decorate($message, '期望 false，实际 ' . self::export($value)));
        }
    }

    public static function assertThrows(string $expectedClass, callable $fn, string $message = ''): void
    {
        try {
            $fn();
        } catch (\Throwable $e) {
            if (!($e instanceof $expectedClass)) {
                throw new AssertionFailed(self::decorate(
                    $message,
                    sprintf('期望抛出 %s，实际抛出 %s: %s', $expectedClass, get_class($e), $e->getMessage())
                ));
            }

            return;
        }

        throw new AssertionFailed(self::decorate($message, sprintf('期望抛出 %s，但没有抛出任何异常', $expectedClass)));
    }

    public static function assertStringContains(string $needle, string $haystack, string $message = ''): void
    {
        if (strpos($haystack, $needle) === false) {
            throw new AssertionFailed(self::decorate(
                $message,
                sprintf('字符串 %s 中未找到 %s', self::export($haystack), self::export($needle))
            ));
        }
    }

    private static function decorate(string $message, string $detail): string
    {
        return $message === '' ? $detail : $message . ' —— ' . $detail;
    }

    /**
     * @param mixed $value
     */
    private static function export($value): string
    {
        if (is_string($value)) {
            return '"' . $value . '"';
        }
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if ($value === null) {
            return 'null';
        }
        if (is_float($value)) {
            return (string) json_encode($value);
        }
        if (is_scalar($value)) {
            return (string) $value;
        }

        $encoded = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

        return is_string($encoded) ? $encoded : gettype($value);
    }

    /* ------------------------- 汇总 ------------------------- */

    public static function summary(): int
    {
        $failed = count(self::$failures);

        echo PHP_EOL . str_repeat('-', 64) . PHP_EOL;
        if ($failed === 0) {
            printf(
                '%s：%d 个用例%s (PHP %s)' . PHP_EOL,
                self::paint('全部通过', '32'),
                self::$passed,
                self::$skipped > 0 ? sprintf('，跳过 %d 个', self::$skipped) : '',
                PHP_VERSION
            );

            return 0;
        }

        printf(
            '%s，通过 %d 个 (PHP %s)' . PHP_EOL,
            self::paint(sprintf('失败 %d 个', $failed), '31'),
            self::$passed,
            PHP_VERSION
        );
        foreach (self::$failures as [$name, $message]) {
            echo '  ✗ ' . $name . PHP_EOL . '      ' . $message . PHP_EOL;
        }

        return 1;
    }
}
