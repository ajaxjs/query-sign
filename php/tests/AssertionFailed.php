<?php

declare(strict_types=1);

namespace QuerySign\Tests;

/**
 * 断言失败专用异常，与「被测代码自身抛出的异常」区分开，
 * 便于测试运行器给出准确的失败原因。
 */
final class AssertionFailed extends \RuntimeException
{
}
