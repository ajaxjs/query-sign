<?php

declare(strict_types=1);

namespace QuerySign\Tests;

use QuerySign\Exception\ExceptionInterface;
use QuerySign\Exception\InvalidArgumentException;
use QuerySign\QuerySign;

/**
 * PHP 实现的单元测试：覆盖 API 契约、配置校验、异常语义与 PHP 特有的类型转换。
 */
final class UnitTests
{
    private const SECRET = 'unit-secret';

    private function __construct()
    {
    }

    /**
     * @param array<string, mixed> $options
     */
    private static function make(array $options = []): QuerySign
    {
        return new QuerySign(array_merge(['secret' => self::SECRET], $options));
    }

    /**
     * 判断数组是否为「列表形态」（键为 0..n-1 的连续整数）。
     * 刻意不复用 QuerySign 内部的判定，避免测试与被测代码同源出错。
     *
     * @param array<array-key, mixed> $value
     */
    private static function isListShape(array $value): bool
    {
        return $value !== [] && array_keys($value) === range(0, count($value) - 1);
    }

    public static function register(): void
    {
        self::constants();
        self::constructorValidation();
        self::dataContract();
        self::canonicalization();
        self::floatFormatting();
        self::signAndVerify();
        self::toStringContract();
        self::environmentRobustness();
    }

    /* ------------------------- 常量 ------------------------- */

    private static function constants(): void
    {
        Harness::group('常量与元信息');

        Harness::test('SPEC_VERSION 为 1', static function (): void {
            Harness::assertSame(1, QuerySign::SPEC_VERSION);
        });

        Harness::test('COMMON_ALGORITHMS 均被当前 PHP 支持', static function (): void {
            $available = hash_algos();
            foreach (QuerySign::COMMON_ALGORITHMS as $algo) {
                Harness::assertTrue(in_array($algo, $available, true), "算法 {$algo} 不可用");
            }
        });
    }

    /* ------------------------- 构造校验 ------------------------- */

    private static function constructorValidation(): void
    {
        Harness::group('构造参数校验');

        Harness::test('缺少 secret 抛异常', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                new QuerySign([]);
            });
        });

        Harness::test('secret 为空串抛异常', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                new QuerySign(['secret' => '']);
            });
        });

        Harness::test('secret 非字符串抛异常', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                new QuerySign(['secret' => 12345]);
            });
        });

        Harness::test('signField 为空串抛异常', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                new QuerySign(['secret' => 's', 'signField' => '']);
            });
        });

        Harness::test('encoding 非法抛异常', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                new QuerySign(['secret' => 's', 'encoding' => 'base32']);
            });
        });

        Harness::test('algorithm 不受支持抛异常', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                new QuerySign(['secret' => 's', 'algorithm' => 'not-a-real-algo']);
            });
        });

        Harness::test('异常同时是 SPL InvalidArgumentException 与标记接口', static function (): void {
            try {
                new QuerySign([]);
                throw new AssertionFailed('应当抛出异常');
            } catch (\Throwable $e) {
                Harness::assertTrue($e instanceof \InvalidArgumentException, '应继承 \InvalidArgumentException');
                Harness::assertTrue($e instanceof ExceptionInterface, '应实现 ExceptionInterface');
            }
        });

        Harness::test('options() 返回补全后的配置副本', static function (): void {
            $qs = self::make(['algorithm' => 'sha1']);
            Harness::assertSame([
                'secret' => self::SECRET,
                'signField' => 'sign',
                'algorithm' => 'sha1',
                'encoding' => 'hex',
                'uppercase' => false,
                'loose' => false,
            ], $qs->options());
        });

        Harness::test('algorithm 大小写不敏感', static function (): void {
            $upper = self::make(['algorithm' => 'SHA256']);
            $lower = self::make(['algorithm' => 'sha256']);
            $upper->data(['a' => 1]);
            $lower->data(['a' => 1]);
            Harness::assertSame($lower->getSign(), $upper->getSign());
            Harness::assertSame('sha256', $upper->options()['algorithm']);
        });
    }

    /* ------------------------- data() 契约 ------------------------- */

    private static function dataContract(): void
    {
        Harness::group('data() 契约');

        Harness::test('data() 返回 $this 支持链式调用', static function (): void {
            $qs = self::make();
            Harness::assertTrue($qs->data(['a' => 1]) === $qs);
        });

        Harness::test('data(null) 清空数据', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1])->data(null);
            Harness::assertSame([], $qs->getData());
            Harness::assertSame('', $qs->getStringToSign());
        });

        Harness::test('data() 省略参数等价于清空（与 Node.js 端一致）', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1])->data();
            Harness::assertSame([], $qs->getData());
            Harness::assertSame('', $qs->getStringToSign());
        });

        Harness::test('默认数据为空映射', static function (): void {
            Harness::assertSame([], self::make()->getData());
        });

        Harness::test('接受顶层索引数组，下标直接作为键名', static function (): void {
            $qs = self::make();
            $qs->data([10, 20]);
            Harness::assertSame('0=10&1=20', $qs->getStringToSign());
        });

        Harness::test('顶层索引数组与等价的数字键映射签名一致（跨语言互操作关键）', static function (): void {
            $list = self::make();
            $list->data([10, 20]);
            $map = self::make();
            $map->data(['0' => 10, '1' => 20]);
            Harness::assertSame($list->getSign(), $map->getSign());
        });

        Harness::test('顶层索引数组的 sign() 返回关联数组', static function (): void {
            $qs = self::make();
            $qs->data([10, 20]);
            $signed = $qs->sign();
            Harness::assertFalse(self::isListShape($signed), 'sign() 必须恒返回映射');
            Harness::assertSame([0 => 10, 1 => 20, 'sign' => $qs->getSign()], $signed);
            // 签名字段必须能被 json_encode 保留，与 Node.js 端形态一致
            Harness::assertStringContains('"sign":"' . $qs->getSign() . '"', (string) json_encode($signed));
        });

        Harness::test('顶层索引数组读不到签名字段时 verify() 为 false', static function (): void {
            $qs = self::make();
            $qs->data([10, 20]);
            Harness::assertFalse($qs->verify());
            Harness::assertTrue($qs->verify($qs->getSign()));
        });

        Harness::test('顶层标量抛 TypeError', static function (): void {
            // data() 的参数类型为 ?array，传标量由 PHP 原生类型系统拒绝
            Harness::assertThrows(\TypeError::class, static function (): void {
                self::make()->data('plain-string');
            });
            Harness::assertThrows(\TypeError::class, static function (): void {
                self::make()->data(42);
            });
        });

        Harness::test('顶层空数组按空映射处理', static function (): void {
            $qs = self::make();
            $qs->data([]);
            Harness::assertSame('', $qs->getStringToSign());
        });

        Harness::test('getData() 返回副本，修改副本不影响签名', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1, 'n' => ['x' => 1]]);
            $before = $qs->getSign();

            $copy = $qs->getData();
            $copy['a'] = 999;
            $copy['n']['x'] = 999;

            Harness::assertSame($before, $qs->getSign(), '内部数据被外部修改污染');
            Harness::assertSame(1, $qs->getData()['a']);
        });

        Harness::test('data() 深拷贝，修改源数组不影响签名', static function (): void {
            $source = ['a' => 1, 'nested' => ['b' => 2]];
            $qs = self::make();
            $qs->data($source);
            $before = $qs->getSign();

            $source['a'] = 100;
            $source['nested']['b'] = 200;

            Harness::assertSame($before, $qs->getSign());
        });

        Harness::test('拒绝 stdClass 对象', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                self::make()->data(['a' => new \stdClass()]);
            });
        });

        Harness::test('拒绝 DateTime 对象', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                self::make()->data(['at' => new \DateTimeImmutable('2024-01-01')]);
            });
        });

        Harness::test('拒绝资源类型', static function (): void {
            $handle = fopen('php://memory', 'rb');
            try {
                Harness::assertThrows(InvalidArgumentException::class, static function () use ($handle): void {
                    self::make()->data(['h' => $handle]);
                });
            } finally {
                if (is_resource($handle)) {
                    fclose($handle);
                }
            }
        });

        Harness::test('拒绝闭包', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                self::make()->data(['fn' => static function (): void {
                }]);
            });
        });
    }

    /* ------------------------- 规范化 ------------------------- */

    private static function canonicalization(): void
    {
        Harness::group('规范化 stringToSign');

        Harness::test('null 丢弃、空串保留', static function (): void {
            $qs = self::make();
            $qs->data(['keep' => '', 'drop' => null, 'z' => 'v']);
            Harness::assertSame('keep=&z=v', $qs->getStringToSign());
        });

        Harness::test('布尔值归一化为 true/false', static function (): void {
            $qs = self::make();
            $qs->data(['t' => true, 'f' => false]);
            Harness::assertSame('f=false&t=true', $qs->getStringToSign());
        });

        Harness::test('嵌套按方括号记法扁平化', static function (): void {
            $qs = self::make();
            $qs->data(['a' => ['b' => ['c' => 1]], 'l' => [10, 20]]);
            Harness::assertSame('a%5Bb%5D%5Bc%5D=1&l%5B0%5D=10&l%5B1%5D=20', $qs->getStringToSign());
        });

        Harness::test('数组中的 null 保留原始下标', static function (): void {
            $qs = self::make();
            $qs->data(['a' => [10, null, 20]]);
            Harness::assertSame('a%5B0%5D=10&a%5B2%5D=20', $qs->getStringToSign());
        });

        Harness::test('空容器被整体丢弃', static function (): void {
            $qs = self::make();
            $qs->data(['o' => [], 'real' => 'yes', 'n' => ['empty' => []]]);
            Harness::assertSame('real=yes', $qs->getStringToSign());
        });

        Harness::test('顶层签名字段被剔除', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1, 'sign' => 'stale']);
            Harness::assertSame('a=1', $qs->getStringToSign());
        });

        Harness::test('嵌套签名字段照常参与签名', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1, 'meta' => ['sign' => 'inner']]);
            Harness::assertSame('a=1&meta%5Bsign%5D=inner', $qs->getStringToSign());
        });

        Harness::test('自定义 signField', static function (): void {
            $qs = self::make(['signField' => 'signature']);
            $qs->data(['a' => 1, 'sign' => 'kept', 'signature' => 'dropped']);
            Harness::assertSame('a=1&sign=kept', $qs->getStringToSign());
        });

        Harness::test('RFC 3986：空格编为 %20，~ 不编码', static function (): void {
            $qs = self::make();
            $qs->data(['sp' => 'a b', 'ti' => 'a~b', 'pl' => 'a+b']);
            Harness::assertSame('pl=a%2Bb&sp=a%20b&ti=a~b', $qs->getStringToSign());
        });

        Harness::test('RFC 3986：!\'()* 均需转义（对齐 rawurlencode）', static function (): void {
            $qs = self::make();
            $qs->data(['v' => "!\"'()*"]);
            Harness::assertSame('v=%21%22%27%28%29%2A', $qs->getStringToSign());
        });

        Harness::test('整型键按十进制字符串参与签名', static function (): void {
            $qs = self::make();
            $qs->data([10 => 'a', 9 => 'b']);
            Harness::assertSame('10=a&9=b', $qs->getStringToSign());
        });

        Harness::test('扁平化后重复键抛异常', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                $qs = self::make();
                $qs->data(['a[b]' => 'scalar', 'a' => ['b' => 'nested']]);
                $qs->getSign();
            });
        });

        Harness::test('NAN 抛异常', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                $qs = self::make();
                $qs->data(['v' => NAN]);
                $qs->getSign();
            });
        });

        Harness::test('INF 抛异常', static function (): void {
            Harness::assertThrows(InvalidArgumentException::class, static function (): void {
                $qs = self::make();
                $qs->data(['v' => INF]);
                $qs->getSign();
            });
        });
    }

    /* ------------------------- 浮点格式化 ------------------------- */

    private static function floatFormatting(): void
    {
        Harness::group('浮点格式化（对齐 JS Number#toString）');

        $cases = [
            '整数值浮点 2.0' => [2.0, '2'],
            '整数值浮点 100.0' => [100.0, '100'],
            '整数值浮点 120000.0' => [120000.0, '120000'],
            '正零' => [0.0, '0'],
            '负零' => [-0.0, '0'],
            '0.1' => [0.1, '0.1'],
            '1/3' => [1 / 3, '0.3333333333333333'],
            '1e-6 用定点' => [1e-6, '0.000001'],
            '1e-7 用指数' => [1e-7, '1e-7'],
            '-1.5e-7' => [-1.5e-7, '-1.5e-7'],
            '1e20 用定点' => [1e20, '100000000000000000000'],
            '1e21 用指数' => [1e21, '1e+21'],
            '2^53' => [9007199254740992.0, '9007199254740992'],
            '负整数浮点' => [-5.0, '-5'],
            '1.5' => [1.5, '1.5'],
            '-0.5' => [-0.5, '-0.5'],
        ];

        foreach ($cases as $name => [$input, $expected]) {
            Harness::test($name . ' => ' . $expected, static function () use ($input, $expected): void {
                $qs = UnitTests::make();
                $qs->data(['v' => $input]);
                // getStringToSign() 会做 RFC 3986 编码（例如 1e+21 -> 1e%2B21），
                // 这里解码后比对，让期望值保持与 JS `String(n)` 一致的可读形式
                Harness::assertSame('v=' . $expected, rawurldecode($qs->getStringToSign()));
            });
        }

        Harness::test('整数类型不使用科学计数法', static function (): void {
            $qs = self::make();
            $qs->data(['i' => 1000000000000000, 'n' => -5, 'z' => 0]);
            Harness::assertSame('i=1000000000000000&n=-5&z=0', $qs->getStringToSign());
        });
    }

    /* ------------------------- 签名与验签 ------------------------- */

    private static function signAndVerify(): void
    {
        Harness::group('getSign() / sign() / verify()');

        Harness::test('getSign() 幂等，且不因其它方法调用而改变', static function (): void {
            $qs = self::make();
            $qs->data(['b' => 2, 'a' => 1]);

            $first = $qs->getSign();
            $qs->toString();
            $qs->sign();
            $qs->getStringToSign();

            Harness::assertSame($first, $qs->getSign(), 'getSign() 必须幂等');
        });

        Harness::test('键插入顺序不影响签名', static function (): void {
            $a = self::make();
            $b = self::make();
            $a->data(['a' => 1, 'b' => 2, 'c' => 3]);
            $b->data(['c' => 3, 'b' => 2, 'a' => 1]);
            Harness::assertSame($a->getSign(), $b->getSign());
            Harness::assertSame($a->getStringToSign(), $b->getStringToSign());
        });

        Harness::test('sign() 返回原数据 + 签名字段', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1, 'n' => ['b' => 2]]);
            $signed = $qs->sign();

            Harness::assertSame(1, $signed['a']);
            Harness::assertSame(['b' => 2], $signed['n']);
            Harness::assertSame($qs->getSign(), $signed['sign']);
        });

        Harness::test('sign() 覆盖已有的过期签名字段且不产生重复键', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1, 'sign' => 'stale-value']);
            $signed = $qs->sign();

            Harness::assertSame(['a', 'sign'], array_keys($signed));
            Harness::assertSame($qs->getSign(), $signed['sign']);
            Harness::assertFalse($signed['sign'] === 'stale-value');
        });

        Harness::test('sign() 不修改内部数据', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1]);
            $qs->sign();
            Harness::assertFalse(array_key_exists('sign', $qs->getData()));
        });

        Harness::test('sign() 使用自定义 signField', static function (): void {
            $qs = self::make(['signField' => 'signature']);
            $qs->data(['a' => 1]);
            $signed = $qs->sign();
            Harness::assertTrue(array_key_exists('signature', $signed));
            Harness::assertFalse(array_key_exists('sign', $signed));
        });

        Harness::test('verify() 省略参数时从数据中读取', static function (): void {
            $qs = self::make();
            $sign = (static function () use ($qs): string {
                $qs->data(['a' => 1]);

                return $qs->getSign();
            })();

            $qs->data(['a' => 1, 'sign' => $sign]);
            Harness::assertTrue($qs->verify());
        });

        Harness::test('verify() 显式传参优先于数据', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1]);
            Harness::assertTrue($qs->verify($qs->getSign()));
        });

        Harness::test('verify() 数据被篡改后返回 false', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1]);
            $sign = $qs->getSign();

            $qs->data(['a' => 2, 'sign' => $sign]);
            Harness::assertFalse($qs->verify());
        });

        Harness::test('verify() 缺少签名字段返回 false', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1]);
            Harness::assertFalse($qs->verify());
        });

        Harness::test('verify() 对非字符串输入返回 false 且不抛异常', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1]);
            Harness::assertFalse($qs->verify(123));
            Harness::assertFalse($qs->verify([]));
            Harness::assertFalse($qs->verify(true));
            Harness::assertFalse($qs->verify(''));
        });

        Harness::test('verify() 对长度不同的输入返回 false', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1]);
            Harness::assertFalse($qs->verify('short'));
            Harness::assertFalse($qs->verify(str_repeat('0', 512)));
        });

        Harness::test('verify() 对多字节字符输入不抛异常', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1]);
            // 64 个多字节字符：字符数与 hex 长度可能相同，但字节数不同
            Harness::assertFalse($qs->verify(str_repeat('密', 64)));
        });

        Harness::test('严格模式下大写 hex 验签失败', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1]);
            Harness::assertFalse($qs->verify(strtoupper($qs->getSign())));
        });

        Harness::test('loose 模式下大写 hex 验签通过', static function (): void {
            $qs = self::make(['loose' => true]);
            $qs->data(['a' => 1]);
            Harness::assertTrue($qs->verify(strtoupper($qs->getSign())));
            Harness::assertTrue($qs->verify(strtolower($qs->getSign())));
        });

        Harness::test('loose 模式不影响 base64 编码', static function (): void {
            $qs = self::make(['encoding' => 'base64', 'loose' => true]);
            $qs->data(['a' => 1]);
            Harness::assertTrue($qs->verify($qs->getSign()));
            Harness::assertFalse($qs->verify(strtoupper($qs->getSign()) . 'x'));
        });

        Harness::test('不同算法产出不同签名且长度符合预期', static function (): void {
            $lengths = ['md5' => 32, 'sha1' => 40, 'sha256' => 64, 'sha512' => 128];
            $signs = [];
            foreach ($lengths as $algo => $len) {
                $qs = self::make(['algorithm' => $algo]);
                $qs->data(['a' => 1]);
                $signs[$algo] = $qs->getSign();
                Harness::assertSame($len, strlen($signs[$algo]), "{$algo} 长度应为 {$len}");
            }
            Harness::assertSame(4, count(array_unique($signs)), '不同算法不应产生相同签名');
        });

        Harness::test('uppercase 输出大写 hex', static function (): void {
            $qs = self::make(['uppercase' => true]);
            $qs->data(['a' => 1]);
            $sign = $qs->getSign();
            Harness::assertSame(strtoupper($sign), $sign);
            Harness::assertSame(64, strlen($sign));
        });

        Harness::test('不同 secret 产生不同签名', static function (): void {
            $a = new QuerySign(['secret' => 'secret-a']);
            $b = new QuerySign(['secret' => 'secret-b']);
            $a->data(['x' => 1]);
            $b->data(['x' => 1]);
            Harness::assertFalse($a->getSign() === $b->getSign());
        });
    }

    /* ------------------------- toString ------------------------- */

    private static function toStringContract(): void
    {
        Harness::group('toString()');

        Harness::test('__toString() 与 toString() 等价', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1, 'b' => 'x y']);
            Harness::assertSame($qs->toString(), (string) $qs);
        });

        Harness::test('拼接格式为 key=value&...&sign=签名', static function (): void {
            $qs = self::make();
            $qs->data(['b' => 2, 'a' => 1]);
            Harness::assertSame(
                'a=1&b=2&sign=' . $qs->getSign(),
                $qs->toString()
            );
        });

        Harness::test('空数据时无前导 &', static function (): void {
            $qs = self::make();
            $qs->data([]);
            Harness::assertSame('sign=' . $qs->getSign(), $qs->toString());
        });

        Harness::test('数据中原有的 sign 只出现一次', static function (): void {
            $qs = self::make();
            $qs->data(['a' => 1, 'sign' => 'stale']);
            $str = $qs->toString();
            Harness::assertSame(1, substr_count($str, 'sign='));
            Harness::assertSame('a=1&sign=' . $qs->getSign(), $str);
        });

        Harness::test('自定义 signField 出现在末尾', static function (): void {
            $qs = self::make(['signField' => 'signature']);
            $qs->data(['a' => 1]);
            Harness::assertSame('a=1&signature=' . $qs->getSign(), $qs->toString());
        });

        Harness::test('base64 签名在 toString 中被正确转义', static function (): void {
            $qs = self::make(['encoding' => 'base64']);
            $qs->data(['a' => 'x', 'b' => 1, 'c' => ['d' => [1, 2]]]);

            $sign = $qs->getSign();
            $str = $qs->toString();
            $suffix = 'sign=' . rawurlencode($sign);

            Harness::assertSame($suffix, substr($str, -strlen($suffix)), 'toString 末尾应为转义后的签名');
            if (strpbrk($sign, '+/=') !== false) {
                Harness::assertFalse(
                    strpos($str, 'sign=' . $sign) !== false,
                    'base64 原始签名不应直接出现在 query string 中'
                );
            }
        });

        Harness::test('toString 结果可被 parse_str 还原', static function (): void {
            $qs = self::make();
            $qs->data(['name' => '张三', 'tags' => ['a', 'b'], 'ok' => true]);
            $str = $qs->toString();

            $parsed = [];
            parse_str($str, $parsed);

            Harness::assertSame('张三', $parsed['name']);
            Harness::assertSame(['a', 'b'], $parsed['tags']);
            Harness::assertSame('true', $parsed['ok']);
            Harness::assertSame($qs->getSign(), $parsed['sign']);
        });
    }

    /* ------------------------- 环境健壮性 ------------------------- */

    private static function environmentRobustness(): void
    {
        Harness::group('环境健壮性');

        Harness::test('serialize_precision 被改为 17 时浮点输出仍与 JS 一致', static function (): void {
            $original = ini_get('serialize_precision');
            if ($original === false || @ini_set('serialize_precision', '17') === false) {
                // 某些环境（php.ini 只读）无法修改，跳过而不判失败
                Harness::assertTrue(true, '当前环境不可修改 serialize_precision，已跳过');

                return;
            }

            try {
                $qs = self::make();
                $qs->data([
                    'tenth' => 0.1,
                    'third' => 1 / 3,
                    'nano' => 1e-7,
                    'huge' => 1e21,
                    'integral' => 2.0,
                ]);
                // serialize_precision=17 会让 json_encode(0.1) 变成 0.10000000000000001，
                // 库必须内部临时切回 -1，输出才与 Node.js 的 String(0.1) 一致
                Harness::assertSame(
                    'huge=1e%2B21&integral=2&nano=1e-7&tenth=0.1&third=0.3333333333333333',
                    $qs->getStringToSign()
                );
            } finally {
                @ini_set('serialize_precision', $original);
            }
        });

        Harness::test('库调用后 serialize_precision 被还原', static function (): void {
            $original = ini_get('serialize_precision');
            if ($original === false || @ini_set('serialize_precision', '17') === false) {
                Harness::assertTrue(true, '当前环境不可修改 serialize_precision，已跳过');

                return;
            }

            try {
                $qs = self::make();
                $qs->data(['v' => 0.1]);
                $qs->getSign();
                Harness::assertSame('17', (string) ini_get('serialize_precision'), '库不应永久改动 ini 配置');
            } finally {
                @ini_set('serialize_precision', $original);
            }
        });

        Harness::test('64 位整型假设成立', static function (): void {
            Harness::assertSame(8, PHP_INT_SIZE, '本库的整型语义要求 64 位 PHP');
        });
    }
}
