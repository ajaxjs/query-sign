/**
 * scripts/lib/placeholders.mjs 的单元测试。
 *
 * 运行: npm run test:scripts
 *
 * 占位符扫描漏检的后果是「把带 OWNER 的仓库地址发到公共平台」，
 * 属于难以撤回的发布级事故，因此单独覆盖。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DOC_REGION_END,
  DOC_REGION_START,
  PLACEHOLDERS,
  scanJsonManifests,
  scanTextDocuments,
  scannableLines,
} from './placeholders.mjs';

/** 取出待扫描行的行号，便于断言 */
const lineNumbers = (text) => scannableLines(text).map((l) => l.number);

describe('scannableLines', () => {
  it('无标记时保留全部行，行号 1-based', () => {
    assert.deepEqual(lineNumbers('a\nb\nc'), [1, 2, 3]);
  });

  it('豁免区域内的行连同标记本身一起被剔除', () => {
    const text = ['保留', DOC_REGION_START, '豁免', DOC_REGION_END, '保留'].join('\n');
    const kept = scannableLines(text);

    assert.deepEqual(kept.map((l) => l.text), ['保留', '保留']);
    // 行号仍指向原文位置，剔除不会让行号错位
    assert.deepEqual(kept.map((l) => l.number), [1, 5]);
  });

  it('标记必须独占一行；正文里内联提到标记字面量不会误开豁免', () => {
    // 这是根 README 的真实形态：解释标记用法的那句话本身含有标记字面量。
    // 若用 includes 判断，这句话会重新打开豁免且再也关不上，
    // 导致文件后半部分的真实占位符全部漏检。
    const text = [
      DOC_REGION_START,
      '| `OWNER` | 表格 |',
      DOC_REGION_END,
      `上面这一节被 ${DOC_REGION_START} / ${DOC_REGION_END} 圈了起来。`,
      'https://github.com/OWNER/query-sign',
    ].join('\n');

    const kept = scannableLines(text);
    assert.deepEqual(kept.map((l) => l.number), [4, 5]);
    assert.match(kept[1].text, /github\.com\/OWNER/);
  });

  it('标记允许首尾空白（Markdown 里常见缩进）', () => {
    const text = ['前', `  ${DOC_REGION_START}  `, '豁免', `\t${DOC_REGION_END}`, '后'].join('\n');
    assert.deepEqual(lineNumbers(text), [1, 5]);
  });

  it('豁免区域可以出现多次，且互不影响', () => {
    const text = [
      'a OWNER',
      DOC_REGION_START,
      'b OWNER',
      DOC_REGION_END,
      'c OWNER',
      DOC_REGION_START,
      'd OWNER',
      DOC_REGION_END,
      'e OWNER',
    ].join('\n');

    const kept = scannableLines(text);
    assert.deepEqual(kept.map((l) => l.text), ['a OWNER', 'c OWNER', 'e OWNER']);
  });

  it('只有起始标记没有结束标记时，其后全部豁免（宁可漏报也不误报刷屏）', () => {
    const text = ['前', DOC_REGION_START, '豁免1', '豁免2'].join('\n');
    assert.deepEqual(lineNumbers(text), [1]);
  });
});

describe('scanJsonManifests', () => {
  it('检出嵌套字段里的占位符', () => {
    const hits = scanJsonManifests([
      ['php/composer.json', { name: 'your-vendor/query-sign', support: { issues: 'https://github.com/OWNER/x/issues' } }],
    ]);

    assert.deepEqual(
      hits.map((h) => `${h.where}:${h.token}`).sort(),
      ['php/composer.json:OWNER', 'php/composer.json:your-vendor']
    );
  });

  it('检出数组元素里的占位符', () => {
    const hits = scanJsonManifests([['m', { keywords: ['ok', 'your-scope'] }]]);
    assert.deepEqual(hits, [{ where: 'm', token: 'your-scope' }]);
  });

  it('干净清单不产生命中', () => {
    const hits = scanJsonManifests([
      ['nodejs/package.json', { name: 'query-sign', repository: { url: 'git+https://github.com/acme/query-sign.git' } }],
    ]);
    assert.deepEqual(hits, []);
  });

  it('同一 token 出现多次只报一次（清单不定位到字段，报多次是噪音）', () => {
    const hits = scanJsonManifests([['m', { a: 'OWNER', b: 'OWNER', c: 'OWNER' }]]);
    assert.equal(hits.length, 1);
  });

  it('所有已知占位符都能被检出', () => {
    for (const token of PLACEHOLDERS) {
      assert.deepEqual(scanJsonManifests([['m', { v: token }]]), [{ where: 'm', token }]);
    }
  });
});

describe('scanTextDocuments', () => {
  it('带上 1-based 行号', () => {
    const text = ['一', '二', 'https://github.com/OWNER/x', '四'].join('\n');
    assert.deepEqual(scanTextDocuments([['README.md', text]]), [
      { where: 'README.md（行 3）', token: 'OWNER' },
    ]);
  });

  it('同一 token 多处命中合并为一条，行号按出现顺序列出', () => {
    const text = ['OWNER a', 'b', 'OWNER c', 'd', 'OWNER e'].join('\n');
    assert.deepEqual(scanTextDocuments([['R.md', text]]), [{ where: 'R.md（行 1, 3, 5）', token: 'OWNER' }]);
  });

  it('超过 5 处时折叠，但仍给出总数', () => {
    const text = Array.from({ length: 8 }, (_, i) => `第${i + 1}行 your-vendor`).join('\n');
    assert.deepEqual(scanTextDocuments([['R.md', text]]), [
      { where: 'R.md（行 1, 2, 3, 4, 5 等 8 处）', token: 'your-vendor' },
    ]);
  });

  it('不同 token 各自成为一条命中，即使出现在同一行', () => {
    const hits = scanTextDocuments([['R.md', 'OWNER 与 your-vendor 同行出现']]);
    assert.deepEqual(hits.map((h) => h.token), ['OWNER', 'your-vendor']);
    assert.deepEqual(hits.map((h) => h.where), ['R.md（行 1）', 'R.md（行 1）']);
  });

  it('豁免区域内的占位符不被报告，区域外的照常报告', () => {
    const text = [
      '[![npm](https://img.shields.io/npm/v/your-vendor-query-sign.svg)]',
      DOC_REGION_START,
      '| `OWNER` | `your-vendor` | 待替换 |',
      'grep -rn "OWNER\\|your-vendor" .',
      DOC_REGION_END,
      '本节说明了 OWNER 的替换方式。',
    ].join('\n');

    const hits = scanTextDocuments([['README.md', text]]);
    // 命中按 PLACEHOLDERS 的顺序分组（token 优先），同一 token 内再按行号升序。
    // 这样报告读起来是「先把所有 OWNER 处理掉，再处理 your-vendor」，比按行号交错更好用。
    assert.deepEqual(hits, [
      { where: 'README.md（行 6）', token: 'OWNER' },
      { where: 'README.md（行 1）', token: 'your-vendor' },
    ]);
  });

  it('干净文档不产生命中', () => {
    assert.deepEqual(scanTextDocuments([['docs/SPEC.md', '# 规范\n无占位符\n']]), []);
  });

  it('空文档数组不报错', () => {
    assert.deepEqual(scanTextDocuments([]), []);
    assert.deepEqual(scanJsonManifests([]), []);
  });
});
