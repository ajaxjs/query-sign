<?php

declare(strict_types=1);

/**
 * 交叉验证的 PHP 侧执行器（由 test/cross-check.mjs 调用）。
 *
 * 读取一个 JSON 文件，其中每个元素形如 { options, data }，
 * 独立重算 stringToSign / sign / toString，并把结果以 JSON 打印到 stdout。
 *
 * 用法：php test/cross-check.php <cases.json>
 */

use QuerySign\QuerySign;
use QuerySign\Tests\FixtureLoader;

require dirname(__DIR__) . '/php/tests/bootstrap.php';

$argvFile = $argv[1] ?? null;
if (!is_string($argvFile) || !is_file($argvFile)) {
    fwrite(STDERR, '用法: php test/cross-check.php <cases.json>' . PHP_EOL);
    exit(2);
}

$raw = file_get_contents($argvFile);
if ($raw === false) {
    fwrite(STDERR, '无法读取: ' . $argvFile . PHP_EOL);
    exit(2);
}

/** @var mixed $cases */
$cases = json_decode($raw, true);
if (!is_array($cases)) {
    fwrite(STDERR, 'cases.json 不是合法 JSON 数组: ' . json_last_error_msg() . PHP_EOL);
    exit(2);
}

$results = [];

foreach ($cases as $index => $case) {
    /** @var array<string, mixed> $options */
    $options = $case['options'];
    $data = FixtureLoader::decodeMarkers($case['data']);

    try {
        $qs = new QuerySign($options);
        $qs->data($data);
        $results[$index] = [
            'ok' => true,
            'stringToSign' => $qs->getStringToSign(),
            'sign' => $qs->getSign(),
            'toString' => $qs->toString(),
            'verified' => $qs->verify($qs->getSign()),
        ];
    } catch (\Throwable $e) {
        $results[$index] = [
            'ok' => false,
            'error' => get_class($e) . ': ' . $e->getMessage(),
        ];
    }
}

echo (string) json_encode($results, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
exit(0);
