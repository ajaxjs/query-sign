<?php

declare(strict_types=1);

/**
 * 语法与元数据自检（零依赖）：
 *   1. 对 src/ 与 tests/ 下所有 .php 文件执行 `php -l`
 *   2. 校验 composer.json 可解析，且 name / autoload 配置合法
 *   3. 若检测到 composer 可执行文件，额外跑一次 `composer validate --strict`
 *
 * 用法：php scripts/lint.php
 * 退出码：0 通过，1 存在问题。
 */

$packageRoot = dirname(__DIR__);
$problems = [];
$checked = 0;

$directories = ['src', 'tests', 'scripts'];

foreach ($directories as $directory) {
    $base = $packageRoot . DIRECTORY_SEPARATOR . $directory;
    if (!is_dir($base)) {
        continue;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($base, FilesystemIterator::SKIP_DOTS)
    );

    foreach ($iterator as $fileInfo) {
        /** @var SplFileInfo $fileInfo */
        if ($fileInfo->getExtension() !== 'php') {
            continue;
        }

        $path = $fileInfo->getPathname();
        $command = escapeshellarg(PHP_BINARY) . ' -l ' . escapeshellarg($path) . ' 2>&1';
        $output = [];
        $status = 0;
        exec($command, $output, $status);
        $checked++;

        if ($status !== 0) {
            $problems[] = '语法错误: ' . $path . PHP_EOL . '    ' . implode(PHP_EOL . '    ', $output);
        }
    }
}

$composerFile = $packageRoot . DIRECTORY_SEPARATOR . 'composer.json';
$composerRaw = is_file($composerFile) ? file_get_contents($composerFile) : false;

if ($composerRaw === false) {
    $problems[] = '缺少 composer.json';
} else {
    /** @var mixed $composer */
    $composer = json_decode($composerRaw, true);
    if (!is_array($composer)) {
        $problems[] = 'composer.json 不是合法 JSON: ' . json_last_error_msg();
    } else {
        $name = $composer['name'] ?? '';
        if (!is_string($name) || preg_match('#^[a-z0-9]([_.-]?[a-z0-9]+)*/[a-z0-9]([_.-]?[a-z0-9]+)*$#', $name) !== 1) {
            $problems[] = 'composer.json 的 name 不合法: ' . var_export($name, true);
        }
        if (!isset($composer['autoload']['psr-4']['QuerySign\\'])
            || $composer['autoload']['psr-4']['QuerySign\\'] !== 'src/') {
            $problems[] = 'composer.json 缺少 PSR-4 自动加载配置 QuerySign\\ => src/';
        }
        if (!isset($composer['license'])) {
            $problems[] = 'composer.json 缺少 license 字段';
        }
    }
}

// 可选：调用 composer validate。
// 仅靠 `where` / `command -v` 探测并不可靠（Windows 上 .phar 可能被关联到 php.exe，
// 命中的路径未必真能执行），因此必须实际跑通 `--version` 才认为 composer 可用。
$isWindows = DIRECTORY_SEPARATOR === '\\';
$candidates = [];

// PATH 上的可执行名
foreach (['composer', 'composer.bat'] as $name) {
    $probe = $isWindows ? 'where ' : 'command -v ';
    $probeOutput = [];
    @exec($probe . escapeshellarg($name) . ' 2>&1', $probeOutput);
    if (isset($probeOutput[0]) && trim($probeOutput[0]) !== '') {
        $candidates[] = trim($probeOutput[0]);
    }
}

// 仓库内可能存在的 phar（用当前 PHP 解释器执行）
foreach ([
    $packageRoot . DIRECTORY_SEPARATOR . 'composer.phar',
    dirname($packageRoot) . DIRECTORY_SEPARATOR . 'composer.phar',
] as $phar) {
    if (is_file($phar)) {
        $candidates[] = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($phar);
    }
}

$composerBin = null;
foreach ($candidates as $candidate) {
    $probeOutput = [];
    $probeStatus = 0;
    @exec($candidate . ' --version 2>&1', $probeOutput, $probeStatus);
    if ($probeStatus === 0 && stripos(implode(' ', $probeOutput), 'Composer') !== false) {
        $composerBin = $candidate;
        break;
    }
}

if ($composerBin !== null) {
    $output = [];
    $status = 0;
    exec(
        $composerBin . ' validate --strict --no-check-publish --working-dir='
            . escapeshellarg($packageRoot) . ' 2>&1',
        $output,
        $status
    );
    if ($status !== 0) {
        $problems[] = 'composer validate 失败:' . PHP_EOL . '    ' . implode(PHP_EOL . '    ', $output);
    } else {
        echo 'composer validate --strict 通过' . PHP_EOL;
    }
} else {
    echo '未检测到可用的 composer，跳过 composer validate' . PHP_EOL;
}

echo sprintf('php -l 检查了 %d 个文件' . PHP_EOL, $checked);

if ($problems !== []) {
    echo PHP_EOL . '发现 ' . count($problems) . ' 个问题:' . PHP_EOL;
    foreach ($problems as $problem) {
        echo '  ✗ ' . $problem . PHP_EOL;
    }
    exit(1);
}

echo '全部通过' . PHP_EOL;
exit(0);
