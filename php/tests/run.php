<?php

declare(strict_types=1);

/**
 * query-sign (PHP) 测试入口 —— 零依赖，无需 composer install。
 *
 * 用法：
 *   php tests/run.php                    运行全部测试
 *   php tests/run.php --filter=float     只运行名称包含 float 的测试
 *   php tests/run.php --no-color         关闭 ANSI 着色
 *
 * 退出码：0 全部通过，1 存在失败，2 参数错误。
 */

use QuerySign\Tests\FixtureTests;
use QuerySign\Tests\Harness;
use QuerySign\Tests\UnitTests;

require __DIR__ . '/bootstrap.php';
require __DIR__ . '/UnitTests.php';
require __DIR__ . '/FixtureTests.php';

/** 终端是否支持 ANSI 着色 */
function detectColorSupport(): bool
{
    if (PHP_SAPI !== 'cli' || getenv('NO_COLOR') !== false) {
        return false;
    }
    if (getenv('FORCE_COLOR') !== false) {
        return true;
    }
    if (DIRECTORY_SEPARATOR === '/') {
        return true;
    }

    // Windows：常见终端会设置其中之一
    return getenv('ANSICON') !== false
        || getenv('ConEmuANSI') === 'ON'
        || getenv('TERM_PROGRAM') !== false
        || getenv('WT_SESSION') !== false;
}

function printUsage(): void
{
    echo <<<TXT
    query-sign (PHP) 测试运行器

    用法: php tests/run.php [选项]

    选项:
      --filter=<keyword>   仅运行名称包含 keyword 的测试（不区分大小写）
      --no-color           关闭 ANSI 着色
      --color              强制开启 ANSI 着色
      -h, --help           显示本帮助

    TXT;
}

$filter = null;
$color = detectColorSupport();

foreach (array_slice($argv, 1) as $arg) {
    if (strncmp($arg, '--filter=', 9) === 0) {
        $filter = substr($arg, 9);
    } elseif ($arg === '--no-color') {
        $color = false;
    } elseif ($arg === '--color') {
        $color = true;
    } elseif ($arg === '-h' || $arg === '--help') {
        printUsage();
        exit(0);
    } else {
        fwrite(STDERR, '未知参数: ' . $arg . PHP_EOL . '（使用 --help 查看用法）' . PHP_EOL);
        exit(2);
    }
}

Harness::setColors($color);
Harness::setFilter($filter);

echo 'query-sign (PHP ' . PHP_VERSION . ') 测试';
if ($filter !== null) {
    echo '，过滤: ' . $filter;
}
echo PHP_EOL;

UnitTests::register();
FixtureTests::register();

exit(Harness::summary());
