<?php

declare(strict_types=1);

namespace QuerySign\Tests;

use QuerySign\Exception\InvalidArgumentException;
use QuerySign\QuerySign;

/**
 * 跨语言一致性测试：逐条比对 test/fixtures.json 中的黄金值。
 *
 * 该文件由 Node.js 参考实现生成，PHP 实现必须产出完全相同的
 * stringToSign / sign / toString，否则视为签名不一致。
 */
final class FixtureTests
{
    private function __construct()
    {
    }

    public static function register(): void
    {
        $doc = FixtureLoader::load();

        Harness::group(sprintf(
            '跨语言一致性 fixtures（%d 例，参考实现: %s，规范 v%d）',
            count($doc['cases']),
            $doc['referenceImplementation'] ?? 'unknown',
            (int) ($doc['specVersion'] ?? 0)
        ));

        Harness::test('规范版本号与实现一致', static function () use ($doc): void {
            Harness::assertSame(
                (int) ($doc['specVersion'] ?? 0),
                QuerySign::SPEC_VERSION,
                'fixtures 的 specVersion 与 QuerySign::SPEC_VERSION 不匹配，请重新生成 fixtures'
            );
        });

        foreach ($doc['cases'] as $case) {
            Harness::test((string) $case['name'], static function () use ($case): void {
                self::runCase($case);
            });
        }
    }

    /**
     * @param array<string, mixed> $case
     */
    private static function runCase(array $case): void
    {
        /** @var array<string, mixed> $options */
        $options = $case['options'];
        $data = FixtureLoader::decodeMarkers($case['data']);
        $expectThrows = ($case['throws'] ?? false) === true;

        if ($expectThrows) {
            Harness::assertThrows(
                InvalidArgumentException::class,
                static function () use ($options, $data): void {
                    $qs = new QuerySign($options);
                    $qs->data($data);
                    $qs->getSign();
                },
                '该用例要求抛出异常'
            );

            return;
        }

        /** @var array{stringToSign: string, sign: string, toString: string} $expect */
        $expect = $case['expect'];

        $qs = new QuerySign($options);
        $qs->data($data);

        Harness::assertSame($expect['stringToSign'], $qs->getStringToSign(), 'stringToSign 与 Node.js 不一致');
        Harness::assertSame($expect['sign'], $qs->getSign(), 'sign 与 Node.js 不一致');
        Harness::assertSame($expect['toString'], $qs->toString(), 'toString 与 Node.js 不一致');

        // 显式传入签名时必须通过
        Harness::assertTrue($qs->verify($expect['sign']), 'verify(sign) 应为 true');

        // 篡改最后一位必须失败
        $tampered = substr($expect['sign'], 0, -1)
            . (substr($expect['sign'], -1) === '0' ? '1' : '0');
        Harness::assertFalse($qs->verify($tampered), '篡改签名后 verify 应为 false');

        // 省略参数时必须从 data[signField] 读取
        $signField = isset($options['signField']) ? (string) $options['signField'] : 'sign';
        /** @var array<string, mixed> $dataWithSign */
        $dataWithSign = $data;
        $dataWithSign[$signField] = $expect['sign'];

        $withSign = new QuerySign($options);
        $withSign->data($dataWithSign);

        Harness::assertTrue($withSign->verify(), 'verify() 从数据读取应为 true');
        Harness::assertFalse($withSign->verify($tampered), '数据中的签名被篡改后应为 false');
        Harness::assertFalse($qs->verify(), '数据中无有效签名字段时 verify() 应为 false');
    }
}
