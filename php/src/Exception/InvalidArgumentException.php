<?php

declare(strict_types=1);

namespace QuerySign\Exception;

/**
 * 配置或数据非法时抛出。
 *
 * 继承自 SPL 的 \InvalidArgumentException，业务方既可以捕获本类，
 * 也可以沿用 \InvalidArgumentException。
 */
class InvalidArgumentException extends \InvalidArgumentException implements ExceptionInterface
{
}
