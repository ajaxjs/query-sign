<?php

declare(strict_types=1);

/**
 * 测试引导：优先使用 Composer 自动加载；
 * 未执行 `composer install` 时回退到内置 PSR-4 加载器，保证测试零依赖可跑。
 */

$composerAutoload = dirname(__DIR__) . '/vendor/autoload.php';

if (is_file($composerAutoload)) {
    require $composerAutoload;
} else {
    spl_autoload_register(static function (string $class): void {
        $prefix = 'QuerySign\\';
        if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
            return;
        }

        $relative = substr($class, strlen($prefix));
        $file = dirname(__DIR__) . '/src/' . str_replace('\\', '/', $relative) . '.php';
        if (is_file($file)) {
            require $file;
        }
    });
}

// 测试基础设施显式加载，避免依赖 autoload-dev 是否已生成
require __DIR__ . '/AssertionFailed.php';
require __DIR__ . '/Harness.php';
require __DIR__ . '/FixtureLoader.php';
