/**
 * 占位符扫描（发布预检用）。
 *
 * 抽成独立模块的理由与 version.mjs 相同：扫描漏检的后果是「把带 OWNER 的仓库地址
 * 发到公共平台」，属于难以撤回的发布级事故，因此这段逻辑必须能被单独测试。
 *
 * 本模块只做纯文本判断，不碰文件系统，调用方负责读文件。
 */

/**
 * 未替换的占位符。发布前必须全部改成真实值。
 *
 * 大小写变体都要列：`your-vendor` 是 Composer 包名的约定写法，
 * `YOUR_VENDOR` 是环境变量写法，两者都可能出现在文档示例里。
 */
export const PLACEHOLDERS = ['OWNER', 'your-vendor', 'YOUR_VENDOR', 'your-scope'];

/**
 * 文档中允许保留占位符的区域标记。
 *
 * 根 README 需要「指名道姓」地列出待替换的占位符，这类说明本身不是坏链；
 * 否则替换完成之后，那一节会永远触发误报。用一对 HTML 注释把区域圈起来即可
 * 跳过扫描，Markdown 渲染后不可见。
 */
export const DOC_REGION_START = '<!-- placeholder-doc-start -->';
export const DOC_REGION_END = '<!-- placeholder-doc-end -->';

/** 单个 token 最多列出多少处行号，超出则折叠为「等 N 处」，避免刷屏 */
const MAX_SHOWN_LINES = 5;

/**
 * 从文档文本中挑出需要参与扫描的行。
 *
 * 被 DOC_REGION_START / DOC_REGION_END 圈住的行整体豁免。
 * 标记必须**独占一行**（trim 后完全相等）才生效。否则文档里那句解释标记用法的
 * 正文——它内联提到了标记字面量——会把豁免状态重新打开且再也关不上，
 * 导致文件后半部分被整体跳过、真实的占位符漏检。
 *
 * @param {string} text 文档全文
 * @returns {Array<{ text: string, number: number }>} 待扫描的行（number 为 1-based 行号）
 */
export function scannableLines(text) {
  const kept = [];
  let exempt = false;

  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === DOC_REGION_START) {
      exempt = true;
      return;
    }
    if (trimmed === DOC_REGION_END) {
      exempt = false;
      return;
    }
    if (!exempt) kept.push({ text: line, number: index + 1 });
  });

  return kept;
}

/**
 * 扫描包清单对象。
 *
 * 清单命中意味着包名 / 仓库地址本身就是错的，比文档坏链更严重。
 *
 * @param {Array<[string, unknown]>} entries `[位置标签, 清单对象]`
 * @returns {Array<{ where: string, token: string }>}
 */
export function scanJsonManifests(entries) {
  const hits = [];

  for (const [where, manifest] of entries) {
    const text = JSON.stringify(manifest);
    for (const token of PLACEHOLDERS) {
      if (text.includes(token)) hits.push({ where, token });
    }
  }

  return hits;
}

/**
 * 扫描文本文档，命中时带上行号，便于直接定位。
 *
 * @param {Array<[string, string]>} entries `[位置标签, 文档全文]`
 * @returns {Array<{ where: string, token: string }>}
 */
export function scanTextDocuments(entries) {
  const hits = [];

  for (const [where, text] of entries) {
    const lines = scannableLines(text);
    for (const token of PLACEHOLDERS) {
      const matched = lines.filter((l) => l.text.includes(token)).map((l) => l.number);
      if (matched.length === 0) continue;

      const shown = matched.slice(0, MAX_SHOWN_LINES).join(', ');
      const rest = matched.length > MAX_SHOWN_LINES ? ` 等 ${matched.length} 处` : '';
      hits.push({ where: `${where}（行 ${shown}${rest}）`, token });
    }
  }

  return hits;
}
