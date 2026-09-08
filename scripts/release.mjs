/**
 * query-sign 一键发布脚本（同时面向 npm 与 Packagist）。
 *
 * 默认「只做校验、不发布」——必须显式加 --publish 才会真正推送产物。
 *
 * 用法:
 *   node scripts/release.mjs                   预检 + 全量校验（不发布）
 *   node scripts/release.mjs --dry-run         额外执行 npm publish --dry-run 预览包内容
 *   node scripts/release.mjs --publish         真正发布（会二次确认）
 *   node scripts/release.mjs --bump=patch      先升版本号再走完整流程
 *   node scripts/release.mjs --publish --tag --push
 *
 * 完整发布（含两端独立仓库拆分）:
 *   node scripts/release.mjs --publish --tag --push --split \
 *     --node-remote=https://github.com/ajaxjs/query-sign-node.git \
 *     --php-remote=https://github.com/ajaxjs/query-sign-php.git
 *
 * 两个平台的发布模型根本不同，脚本分别处理：
 *   - npm       : `npm publish` 直接上传 tarball，不依赖独立仓库
 *   - Packagist : 没有上传命令，包由 git 仓库 + tag 驱动，且要求 composer.json
 *                 位于**仓库根目录**。因此 PHP 端必须有独立仓库，由 --split 生成；
 *                 配置了 API Token 时脚本自动建包，包已存在则改为触发更新
 *
 * 退出码：0 成功，1 校验/发布失败，2 参数错误。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { scanJsonManifests, scanTextDocuments } from './lib/placeholders.mjs';
import {
  NODEJS_DIR,
  PHP_DIR,
  ROOT,
  ReleaseError,
  banner,
  capture,
  confirm,
  hasNpm,
  log,
  npmVersion,
  parseArgs,
  readJson,
  run,
  runNpm,
  writeJson,
} from './lib/util.mjs';
import { isSemver, nextVersion } from './lib/version.mjs';

const PACKAGE_JSON = resolve(NODEJS_DIR, 'package.json');
const COMPOSER_JSON = resolve(PHP_DIR, 'composer.json');
const FIXTURES_JSON = resolve(ROOT, 'test/fixtures.json');

/**
 * 本脚本是顶层顺序执行的 ESM，任何一步抛出的 ReleaseError 都属于
 * 「可预期的发布流程失败」。统一在这里收敛成一行错误消息，
 * 而不是把内部堆栈甩给用户；未预期的错误仍打印完整堆栈以便排查。
 */
function reportFatal(err) {
  log.plain('');
  if (err instanceof ReleaseError) {
    log.fail(err.message);
  } else {
    log.fail('发布脚本发生未预期的错误：');
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
  }
  process.exit(1);
}

process.on('uncaughtException', reportFatal);
process.on('unhandledRejection', reportFatal);

/**
 * 随包一起对外可见的文档。
 * README 会显示在 npm / Packagist 详情页与 GitHub 仓库首页，
 * 里面残留的占位符等于发布了一堆坏链，因此与包清单一同纳入扫描。
 */
const DOC_FILES = ['README.md', 'nodejs/README.md', 'php/README.md', 'docs/SPEC.md'];

let args;
try {
  args = parseArgs(process.argv.slice(2), {
    flags: ['publish', 'dry-run', 'tag', 'push', 'no-input', 'no-fuzz', 'skip-verify', 'help', 'force', 'split'],
    options: [
      'bump', 'only', 'php', 'fuzz', 'message',
      // subtree split：两端各自一个独立仓库，分支名与远端分别指定
      'split-branch', 'node-remote', 'node-branch', 'php-remote', 'php-branch',
    ],
    aliases: { h: 'help', n: 'no-input' },
  });
} catch (err) {
  // 用法错误用退出码 2，与「校验/发布失败」的 1 区分开，便于 CI 判别
  log.fail(err instanceof ReleaseError ? err.message : String(err));
  process.exit(2);
}

if (args.help) {
  printHelp();
  process.exit(0);
}

const only = args.only ? String(args.only).toLowerCase() : 'all';
if (!['all', 'npm', 'packagist'].includes(only)) {
  log.fail(`--only 只接受 npm / packagist / all，收到 "${args.only}"`);
  process.exit(2);
}

const willPublishNpm = args.publish && only !== 'packagist';
const willPublishPhp = args.publish && only !== 'npm';

/**
 * subtree split 的两个目标。
 *
 * 两端都需要独立仓库：Packagist 硬性要求 composer.json 位于**仓库根目录**；
 * npm 包也希望仓库根即包根，否则要靠 repository.directory 多绕一层。
 * monorepo 始终是唯一事实来源，独立仓库由 split 派生，可随时重建。
 *
 * splitBranch 是 monorepo 内承载拆分结果的临时分支，两端**必须不同名**，
 * 否则后跑的会覆盖先跑的；tagPrefix 同理，用于避开主仓库的 vX.Y.Z。
 */
const SPLIT_TARGETS = [
  {
    id: 'npm',
    label: 'Node.js',
    prefix: 'nodejs',
    splitBranch: 'release/node',
    tagPrefix: 'node-v',
    remoteOption: 'node-remote',
    remoteEnv: 'NODE_PACKAGE_REMOTE',
    targetBranch: () => args['node-branch'] || 'main',
    applies: () => willPublishNpm,
  },
  {
    id: 'packagist',
    label: 'PHP',
    prefix: 'php',
    // --split-branch 沿用既有语义，只作用于 PHP 端
    splitBranch: args['split-branch'] || 'packagist',
    tagPrefix: 'php-v',
    remoteOption: 'php-remote',
    remoteEnv: 'PHP_PACKAGE_REMOTE',
    targetBranch: () => args['php-branch'] || 'main',
    applies: () => willPublishPhp,
  },
];

/* ------------------------------------------------------------------ *
 * 1. 读取清单
 * ------------------------------------------------------------------ */

banner('1/6 读取发布清单');

for (const file of [PACKAGE_JSON, COMPOSER_JSON]) {
  if (!existsSync(file)) {
    log.fail(`缺少文件: ${file}`);
    process.exit(1);
  }
}

const npmManifest = readJson(PACKAGE_JSON);
const composerManifest = readJson(COMPOSER_JSON);
const version = String(npmManifest.version || '');

log.ok(`npm      : ${npmManifest.name}@${version}`);
log.ok(`packagist: ${composerManifest.name}（版本由 git tag 决定）`);
if (hasNpm()) log.ok(`npm cli  : ${npmVersion()}`);

/* ------------------------------------------------------------------ *
 * 2. 预检
 * ------------------------------------------------------------------ */

banner('2/6 预检');

const problems = [];
const warnings = [];

// 2.1 占位符
const placeholderHits = findPlaceholders();
if (placeholderHits.length > 0) {
  for (const hit of placeholderHits) {
    problems.push(`存在未替换的占位符 ${hit.token}：${hit.where}`);
  }
} else {
  log.ok('无占位符残留（仓库地址 / 包名 / 作者均已填写）');
}

// 2.2 必填元数据
if (!npmManifest.name) problems.push('nodejs/package.json 缺少 name');
if (!isSemver(version)) {
  problems.push(`nodejs/package.json 的 version 不是合法语义化版本: "${version}"`);
}
if (!npmManifest.license) problems.push('nodejs/package.json 缺少 license');
if (!npmManifest.author || String(npmManifest.author).trim() === '') {
  warnings.push('nodejs/package.json 的 author 为空（不影响发布，但会显示在 npm 页面）');
}
if (!npmManifest.description) problems.push('nodejs/package.json 缺少 description');
if (!composerManifest.license) problems.push('php/composer.json 缺少 license');
if (npmManifest.license !== composerManifest.license) {
  problems.push(
    `两端 license 不一致: npm="${npmManifest.license}" / composer="${composerManifest.license}"`
  );
}

// 2.3 LICENSE：根目录是正本，nodejs/ 与 php/ 各需一份内容相同的副本。
// npm 只打包 nodejs/ 子目录；Packagist 通过 subtree split 把 php/ 变成独立仓库根，
// 两者都看不到根目录的 LICENSE，缺副本会导致包页面没有许可证信息。
const rootLicense = resolve(ROOT, 'LICENSE');
const licenseCopies = [
  ['nodejs/LICENSE', resolve(NODEJS_DIR, 'LICENSE')],
  ['php/LICENSE', resolve(PHP_DIR, 'LICENSE')],
];

if (!existsSync(rootLicense)) {
  problems.push('缺少根目录 LICENSE 文件');
} else {
  const rootText = readFileSync(rootLicense, 'utf8');
  for (const [label, file] of licenseCopies) {
    if (!existsSync(file)) {
      problems.push(`缺少 ${label}；发布产物只包含该子目录，需要一份内容与根目录一致的副本`);
    } else if (readFileSync(file, 'utf8') !== rootText) {
      problems.push(`${label} 与根目录 LICENSE 内容不一致，请重新复制`);
    }
  }
  if (licenseCopies.every(([, file]) => existsSync(file) && readFileSync(file, 'utf8') === rootText)) {
    log.ok('LICENSE 存在，且 nodejs/ 与 php/ 的副本与根目录一致');
  }
}

// 2.4 规范版本号必须三处一致（防止改了实现忘了重新生成黄金用例）
if (existsSync(FIXTURES_JSON)) {
  const fixtures = readJson(FIXTURES_JSON);
  const nodeSpec = readNodeSpecVersion();
  const phpSpec = readPhpSpecVersion();

  if (nodeSpec === null || phpSpec === null) {
    problems.push('无法从源码中读取 SPEC_VERSION，请检查 src 文件是否存在');
  } else if (nodeSpec !== phpSpec) {
    problems.push(`两端 SPEC_VERSION 不一致: Node=v${nodeSpec} / PHP=v${phpSpec}`);
  } else if (fixtures.specVersion !== nodeSpec) {
    problems.push(
      `fixtures 的 specVersion(v${fixtures.specVersion}) 与实现的 SPEC_VERSION(v${nodeSpec}) 不一致，` +
        '请执行 node test/generate-fixtures.mjs 重新生成'
    );
  } else {
    log.ok(`规范版本号一致（v${nodeSpec}），fixtures 共 ${fixtures.cases.length} 例`);
  }
} else {
  problems.push('缺少 test/fixtures.json（请先执行 node test/generate-fixtures.mjs）');
}

// 2.5 git 状态
const gitInfo = inspectGit();
if (!gitInfo.available) {
  warnings.push('git 不可用：无法校验工作区状态，也无法为 Packagist 打 tag');
} else if (!gitInfo.isRepo) {
  problems.push('当前目录不是 git 仓库；Packagist 依赖 git 仓库与 tag，请先 git init');
} else {
  if (gitInfo.dirty && !args.force) {
    problems.push(
      `工作区有未提交的改动（${gitInfo.dirtyFiles.length} 个文件）。请先提交，或用 --force 忽略`
    );
  } else if (gitInfo.dirty) {
    warnings.push('--force：忽略未提交改动继续发布（产物可能与仓库记录不一致）');
  } else {
    log.ok(`工作区干净（分支 ${gitInfo.branch}，提交 ${gitInfo.shortSha}）`);
  }

  if (willPublishPhp && !gitInfo.hasRemote) {
    problems.push('php 发布依赖 git 远端（Packagist 从仓库拉取），但未配置 origin');
  }
  const tag = `v${version}`;
  if (gitInfo.tags.includes(tag)) {
    warnings.push(`git tag ${tag} 已存在，--tag 将跳过创建`);
  }
}

if (!hasNpm() && willPublishNpm) {
  problems.push('npm 不可用，无法发布到 npm');
}

// 2.6 文档齐备：README 会直接显示在 npm / Packagist 详情页上，缺失等于没有说明
for (const relative of DOC_FILES) {
  if (!existsSync(resolve(ROOT, relative))) problems.push(`缺少 ${relative}`);
}
if (DOC_FILES.every((relative) => existsSync(resolve(ROOT, relative)))) {
  log.ok(`文档齐备（${DOC_FILES.join(' / ')}）`);
}

// 2.7 subtree split 的远端地址。
// 只在「既要拆分又要推送」时才是必需的：只拆分不推送是合法用法
// （先在本地生成分支检查产物），所以不能无条件要求远端存在。
if (args.split && args.push) {
  const missing = SPLIT_TARGETS.filter((target) => target.applies() && !splitRemote(target));
  for (const target of missing) {
    problems.push(
      `--split --push 需要为 ${target.label} 端指定远端：` +
      `--${target.remoteOption}=URL（或环境变量 ${target.remoteEnv}）`
    );
  }
  if (missing.length === 0) {
    log.ok('subtree split 远端已配置');
  }
}

for (const warning of warnings) log.warn(warning);
for (const problem of problems) log.fail(problem);

if (problems.length > 0) {
  log.plain('');
  log.fail(`预检未通过，共 ${problems.length} 个问题。修复后重试。`);
  if (placeholderHits.length > 0) {
    log.plain('');
    log.plain('  占位符替换位置：');
    log.plain('    nodejs/package.json  -> repository.url / bugs.url / homepage / author');
    log.plain('    php/composer.json    -> name / support.issues / support.source');
    log.plain('    各 README.md         -> 徽章与文档链接（否则发布后详情页是坏链）');
    log.plain('');
    log.plain('  全局替换示例（把 OWNER / your-vendor 换成真实值）：');
    log.plain('    grep -rn "OWNER\\|your-vendor" --include="*.json" --include="*.md" .');
  }
  process.exit(1);
}
log.ok('预检通过');

/* ------------------------------------------------------------------ *
 * 3. 版本号变更（可选）
 * ------------------------------------------------------------------ */

banner('3/6 版本号');

let releaseVersion = version;

if (args.bump) {
  const next = nextVersion(version, String(args.bump));
  npmManifest.version = next;
  writeJson(PACKAGE_JSON, npmManifest);
  releaseVersion = next;
  log.ok(`版本 ${version} -> ${next}（已写入 nodejs/package.json）`);
  log.info('composer.json 不含 version 字段，Packagist 以 git tag 为准，无需同步');
} else {
  log.ok(`版本保持 ${releaseVersion}（需要升级请加 --bump=patch|minor|major|x.y.z）`);
}

/* ------------------------------------------------------------------ *
 * 4. 全量校验
 * ------------------------------------------------------------------ */

banner('4/6 构建与测试');

if (args['skip-verify']) {
  log.warn('--skip-verify：跳过全部构建/测试/跨语言校验（不建议）');
} else {
  const verifyArgs = [resolve(ROOT, 'scripts/verify.mjs')];
  if (args['no-fuzz']) verifyArgs.push('--no-fuzz');
  if (args.fuzz) verifyArgs.push(`--fuzz=${args.fuzz}`);
  if (args.php) verifyArgs.push(`--php=${args.php}`);

  try {
    run(process.execPath, verifyArgs, { cwd: ROOT });
  } catch (err) {
    log.fail('校验未通过，中止发布');
    log.plain(`    ${err.message}`);
    process.exit(1);
  }
  log.ok('两端构建、测试与跨语言一致性校验全部通过');
}

/* ------------------------------------------------------------------ *
 * 5. 发布
 * ------------------------------------------------------------------ */

banner('5/6 发布');

if (!args.publish) {
  log.info(args['dry-run'] ? '未加 --publish，仅预览' : '未加 --publish，不执行任何发布动作');

  // 注意这里不能用 willPublishNpm：它要求 args.publish 为真，
  // 而 --dry-run 的语义恰恰是「不加 --publish 也要能预览」
  if (args['dry-run'] && only !== 'packagist') {
    log.step('npm publish --dry-run（预览将要上传的文件）');
    // --ignore-scripts: 第 4 步已完整跑过 check，无需让 prepublishOnly 再构建一次
    runNpm(
      ['publish', '--dry-run', '--ignore-scripts', '--access', 'public'],
      { cwd: NODEJS_DIR, allowFailure: true }
    );
  }

  log.plain('');
  log.plain('下一步（确认无误后执行）：');
  log.plain('    node scripts/release.mjs --publish --tag --push --split \\');
  log.plain('      --node-remote=https://github.com/ajaxjs/query-sign-node.git \\');
  log.plain('      --php-remote=https://github.com/ajaxjs/query-sign-php.git');
  log.plain('');
  log.plain('Packagist 首次建包需要账号凭证：配置 PACKAGIST_USERNAME / PACKAGIST_API_TOKEN');
  log.plain('后脚本会自动建包；未配置时需手动到 https://packagist.org/packages/submit 提交。');
  process.exit(0);
}

if ((args.tag || args.push) && !gitInfo.isRepo) {
  log.warn('当前目录不是可用的 git 仓库，跳过 --tag / --push');
}

// 5.1 二次确认
const summary = [
  willPublishNpm ? `npm publish ${npmManifest.name}@${releaseVersion}` : null,
  willPublishPhp ? `Packagist ${composerManifest.name} (tag v${releaseVersion})` : null,
  args.tag ? `创建 git tag v${releaseVersion}` : null,
  args.push ? '推送 commits 与 tags 到 origin' : null,
  ...SPLIT_TARGETS.filter((target) => args.split && target.applies()).map((target) => {
    const remote = splitRemote(target);
    const dest = remote ? normalizeRepoUrl(remote) : '仅生成到本地（未提供 remote）';
    return `subtree split ${target.prefix}/ -> ${dest}`;
  }),
].filter(Boolean);

log.plain('即将执行：');
for (const item of summary) log.plain(`    · ${item}`);
log.plain('');

const confirmed = args['no-input'] || (await confirm('确认发布？此操作不可撤销。'));
if (!confirmed) {
  log.warn('已取消（未确认）');
  process.exit(0);
}

// 5.2 npm
if (willPublishNpm) {
  log.step(`发布到 npm: ${npmManifest.name}@${releaseVersion}`);

  const whoami = runNpm(['whoami'], { quiet: true, allowFailure: true });
  if (!whoami.ok) {
    throw new ReleaseError('未登录 npm，请先执行 npm login（或配置 NODE_AUTH_TOKEN）');
  }
  log.ok(`已登录为 ${whoami.stdout.trim()}`);

  const published = runNpm(['view', npmManifest.name, 'version'], { quiet: true, allowFailure: true });
  if (published.ok && published.stdout.trim() === releaseVersion) {
    throw new ReleaseError(
      `npm 上已存在 ${npmManifest.name}@${releaseVersion}，无法重复发布。请用 --bump 升级版本`
    );
  }

  runNpm(['publish', '--access', 'public'], { cwd: NODEJS_DIR });
  log.ok('npm 发布成功');
}

// 5.3 git tag
if (args.tag && gitInfo.isRepo) {
  log.step(`创建 git tag v${releaseVersion}`);
  const tagName = `v${releaseVersion}`;
  if (gitInfo.tags.includes(tagName)) {
    log.warn(`tag ${tagName} 已存在，跳过创建`);
  } else {
    run('git', [
      'tag',
      '-a',
      tagName,
      '-m',
      args.message || `${npmManifest.name} / ${composerManifest.name} ${tagName}`,
    ], { cwd: ROOT });
    log.ok(`已创建 ${tagName}`);
  }
}

// 5.4 推送
if (args.push && gitInfo.isRepo) {
  log.step('推送到 origin');
  run('git', ['push', 'origin', gitInfo.branch], { cwd: ROOT });
  if (args.tag) run('git', ['push', 'origin', `v${releaseVersion}`], { cwd: ROOT });
  log.ok('推送完成');
}

// 5.5 subtree split：把每个语言子目录拆成「包清单位于仓库根目录」的独立历史
if (args.split) {
  if (!gitInfo.isRepo) {
    throw new ReleaseError('--split 需要当前目录是 git 仓库');
  }

  const targets = SPLIT_TARGETS.filter((target) => target.applies());
  if (targets.length === 0) {
    log.info('--split 无适用目标（受 --only 限制），跳过');
  }
  for (const target of targets) {
    runSubtreeSplit(target);
  }
}

// 5.6 Packagist
if (willPublishPhp) {
  log.step(`Packagist: ${composerManifest.name}`);
  log.info('Packagist 不接受上传，包内容由 git 仓库 + tag 决定');

  const username = process.env.PACKAGIST_USERNAME;
  const token = process.env.PACKAGIST_API_TOKEN;
  // Packagist 上登记的是拆分出来的独立仓库，不是本 monorepo
  const phpTarget = SPLIT_TARGETS.find((target) => target.id === 'packagist');
  const repo = packageRepo(phpTarget);

  if (!username || !token) {
    log.warn('未配置 PACKAGIST_USERNAME / PACKAGIST_API_TOKEN，跳过建包与刷新');
    log.plain('    首次发布请手动提交以下仓库地址：');
    log.plain(`      https://packagist.org/packages/submit`);
    log.plain(`      ${repo}`);
    log.plain('    之后若仓库已配置 GitHub Webhook，push tag 后会自动更新');
  } else {
    // 先建包再回落更新：首次发布时包还不存在，update-package 会失败；
    // 包已存在时 create-package 会失败，此时才轮到 update-package。
    // 这个顺序让同一条命令对首发和后续版本都适用。
    const created = await callPackagist('create-package', username, token, { repository: repo });
    if (created.ok) {
      log.ok(`已在 Packagist 创建包（${repo}）`);
    } else {
      log.info(`create-package 返回 ${created.status}，按「包已存在」处理，改为触发更新`);
      // 字段名与 create-package 相同，都是 repository（不是 url）
      const updated = await callPackagist('update-package', username, token, { repository: repo });
      if (updated.ok) {
        log.ok(`已触发 Packagist 更新（${repo}）`);
      } else {
        log.warn(`触发 Packagist 更新失败（${updated.status}）: ${updated.body.slice(0, 200)}`);
        log.plain('    可登录 packagist.org 手动点击 Update');
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 6. 汇总
 * ------------------------------------------------------------------ */

banner('6/6 完成');
if (willPublishNpm) log.ok(`npm      : https://www.npmjs.com/package/${npmManifest.name}`);
if (willPublishPhp) log.ok(`packagist: https://packagist.org/packages/${composerManifest.name}`);
log.plain('');

/* ------------------------------------------------------------------ *
 * 辅助函数
 * ------------------------------------------------------------------ */

function printHelp() {
  log.plain(`query-sign 一键发布脚本

用法: node scripts/release.mjs [选项]

默认行为: 只做预检 + 构建 + 测试 + 跨语言校验，**不发布**。

发布相关:
  --publish         真正执行发布（会二次确认）
  --dry-run         预览 npm 包内容（npm publish --dry-run），不上传
  --only=TARGET     只发布 npm / packagist（默认 all）
  --no-input, -n    跳过交互确认（CI 环境用）
  --force           忽略工作区未提交改动

版本与 git:
  --bump=LEVEL      升版本: patch / minor / major / prepatch / preminor / premajor
                    或直接给出目标版本号（如 --bump=1.2.0）
  --tag             创建带注释的 git tag vX.Y.Z（版本取自 nodejs/package.json）
  --push            推送当前分支与 tag 到 origin；配合 --split 时也推送拆分结果
  --message=TEXT    自定义 tag 注释

subtree split（两端各对应一个独立仓库）:
  --split           把 nodejs/ 与 php/ 各自拆成「包清单位于仓库根目录」的独立历史
  --node-remote=URL Node 端独立仓库地址（等价于环境变量 NODE_PACKAGE_REMOTE）
  --php-remote=URL  PHP 端独立仓库地址（等价于环境变量 PHP_PACKAGE_REMOTE）
  --node-branch=BR  推送到 Node 仓库的哪个分支（默认 main）
  --php-branch=BR   推送到 PHP 仓库的哪个分支（默认 main）
  --split-branch=BR PHP 端在 monorepo 内的临时分支名（默认 packagist）

校验相关:
  --skip-verify     跳过构建/测试/跨语言校验（不建议）
  --no-fuzz         跳过跨语言模糊测试
  --fuzz=N          模糊测试例数（默认 500）
  --php=BIN         指定 PHP 可执行文件
  -h, --help        显示本帮助

两个平台的发布模型根本不同:
  1) npm 直接上传 tarball，在 nodejs/ 下执行 npm publish 即可，不依赖独立仓库。

  2) Composer 包没有"上传"这一步，Packagist 直接从 git 仓库读取，且要求
     composer.json 位于**仓库根目录**——而本仓库按语言隔离把它放在 php/ 下。
     因此 PHP 端必须有一个独立仓库，由 --split 自动生成并推送：

       node scripts/release.mjs --publish --split --push \\
         --node-remote=https://github.com/ajaxjs/query-sign-node.git \\
         --php-remote=https://github.com/ajaxjs/query-sign-php.git

     --split 对两端分别执行 git subtree split --prefix=nodejs / --prefix=php，
     并打上 node-vX.Y.Z / php-vX.Y.Z tag（推送时映射为独立仓库的 vX.Y.Z）。

  配置以下环境变量后，脚本会调用 Packagist API 自动建包；若包已存在则改为触发更新，
  因此同一条命令对首发和后续版本都适用：
    PACKAGIST_USERNAME, PACKAGIST_API_TOKEN
  未配置时需手动到 https://packagist.org/packages/submit 提交仓库地址。`);
}

/**
 * 扫描包清单与文档中的占位符。
 *
 * 具体规则（豁免区域标记、行号折叠、命中去重）在 scripts/lib/placeholders.mjs，
 * 那里有独立单测覆盖；本函数只负责把文件读进来。
 *
 * 清单命中意味着包名 / 仓库地址本身就是错的；文档命中则是发布后页面上的坏链。
 * 两者都必须在发布前替换成真实值。
 */
function findPlaceholders() {
  const docs = DOC_FILES
    // 文档缺失由 2.6 单独报告，这里跳过即可
    .filter((relative) => existsSync(resolve(ROOT, relative)))
    .map((relative) => [relative, readFileSync(resolve(ROOT, relative), 'utf8')]);

  return [
    ...scanJsonManifests([
      ['nodejs/package.json', npmManifest],
      ['php/composer.json', composerManifest],
    ]),
    ...scanTextDocuments(docs),
  ];
}

/**
 * 从源码中读取 SPEC_VERSION，避免解析构建产物。
 *
 * 三个来源必须一致：Node 实现、PHP 实现、fixtures 黄金用例。
 * 不一致说明改了实现却忘了重新生成 fixtures，发布出去会让两端签名对不上。
 */
function readSpecVersion(file, pattern) {
  if (!existsSync(file)) return null;
  const matched = pattern.exec(readFileSync(file, 'utf8'));
  return matched ? Number.parseInt(matched[1], 10) : null;
}

function readNodeSpecVersion() {
  return readSpecVersion(
    resolve(NODEJS_DIR, 'src/query-sign.ts'),
    /export const SPEC_VERSION\s*=\s*(\d+)/
  );
}

function readPhpSpecVersion() {
  return readSpecVersion(
    resolve(PHP_DIR, 'src/QuerySign.php'),
    /const\s+SPEC_VERSION\s*=\s*(\d+)/
  );
}

function inspectGit() {
  const info = {
    available: false,
    isRepo: false,
    dirty: false,
    dirtyFiles: [],
    branch: '',
    branches: [],
    shortSha: '',
    tags: [],
    hasRemote: false,
  };

  if (!capture('git', ['--version']).ok) return info;
  info.available = true;

  // 必须先确认当前目录真的是 git 仓库，否则 status/rev-parse 全部失败，
  // 会被误读成「工作区干净、无分支」
  const inside = capture('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT });
  if (!inside.ok || inside.stdout.trim() !== 'true') return info;
  info.isRepo = true;

  const status = capture('git', ['status', '--porcelain'], { cwd: ROOT });
  info.dirtyFiles = status.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  info.dirty = info.dirtyFiles.length > 0;

  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT });
  info.branch = branch.ok ? branch.stdout.trim() : '';

  const branches = capture('git', ['branch', '--format=%(refname:short)'], { cwd: ROOT });
  info.branches = branches.ok
    ? branches.stdout.split('\n').map((b) => b.trim()).filter(Boolean)
    : [];

  const sha = capture('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT });
  info.shortSha = sha.ok ? sha.stdout.trim() : '';

  const tags = capture('git', ['tag', '--list'], { cwd: ROOT });
  info.tags = tags.ok ? tags.stdout.split('\n').map((t) => t.trim()).filter(Boolean) : [];

  const remote = capture('git', ['remote', 'get-url', 'origin'], { cwd: ROOT });
  info.hasRemote = remote.ok && remote.stdout.trim() !== '';

  return info;
}

/** 去掉 git+ 前缀与 .git 后缀，得到平台登记用的 https 仓库地址 */
function normalizeRepoUrl(url) {
  return String(url).replace(/^git\+/, '').replace(/\.git$/, '');
}

function repositoryUrl() {
  return normalizeRepoUrl(npmManifest.repository?.url || '');
}

/** 某端 split 的远端地址：命令行参数优先，其次环境变量 */
function splitRemote(target) {
  return args[target.remoteOption] || process.env[target.remoteEnv] || '';
}

/**
 * 某端包在平台上登记的仓库地址。
 *
 * 优先取 split 远端：平台上登记的是拆分出来的**独立仓库**，不是本 monorepo。
 * 未提供远端时回落到 npm 的 repository 字段，至少给出一个可用地址。
 */
function packageRepo(target) {
  const remote = splitRemote(target);
  return remote ? normalizeRepoUrl(remote) : repositoryUrl();
}

/**
 * 把 target.prefix/ 拆成独立历史，打 tag，并按需推送到该端的独立仓库。
 *
 * 拆分结果是**派生产物**：旧的 split 分支与 tag 一律删除重建，
 * 不做增量合并。因此不要手工修改 split 分支——下次发布会被覆盖。
 *
 * 三种收尾状态需要区分清楚，否则会误报原因：
 *   - 未给 remote          -> 本地已生成，提示手工推送命令
 *   - 给了 remote 但没 --push -> 本地已生成，明确说明是 --push 缺失
 *   - 两者都有             -> 推送分支与 tag
 */
function runSubtreeSplit(target) {
  const { prefix, label, splitBranch, tagPrefix } = target;
  const targetBranch = target.targetBranch();
  // split 分支上的 tag 带语言前缀，避免与主仓库的 vX.Y.Z 冲突；
  // 推送到独立仓库时再映射回 vX.Y.Z
  const splitTag = `${tagPrefix}${releaseVersion}`;

  log.step(`为 ${label} 包生成 subtree split（${prefix}/）`);

  // 分支已存在时 subtree split 会拒绝创建，先删掉旧的
  if (gitInfo.branches.includes(splitBranch)) {
    run('git', ['branch', '-D', splitBranch], { cwd: ROOT });
    log.info(`已删除旧的 split 分支 ${splitBranch}`);
  }

  run('git', ['subtree', 'split', `--prefix=${prefix}`, `--branch=${splitBranch}`], { cwd: ROOT });
  log.ok(`已生成 ${splitBranch}（${prefix}/ 的独立历史，包清单在根目录）`);

  if (capture('git', ['rev-parse', '-q', '--verify', `refs/tags/${splitTag}`], { cwd: ROOT }).ok) {
    run('git', ['tag', '-d', splitTag], { cwd: ROOT });
  }
  run('git', ['tag', splitTag, splitBranch], { cwd: ROOT });
  log.ok(`已在 split 历史上打 tag ${splitTag}`);

  const remote = splitRemote(target);
  if (!remote) {
    log.warn(`未提供 --${target.remoteOption}=URL（或环境变量 ${target.remoteEnv}），跳过推送`);
    log.plain('    split 分支与 tag 已生成在本地，可手动推送：');
    log.plain(`      git push <${target.id}-repo-url> ${splitBranch}:${targetBranch}`);
    log.plain(`      git push <${target.id}-repo-url> refs/tags/${splitTag}:refs/tags/v${releaseVersion}`);
    return;
  }

  if (!args.push) {
    log.info(`未加 --push，${label} split 结果保留在本地（${splitBranch} / ${splitTag}）`);
    return;
  }

  log.step(`推送 ${label} 包到独立仓库 ${remote}`);
  // 先分支后 tag：空仓库需要分支先存在，tag 才能落上去
  run('git', ['push', remote, `${splitBranch}:${targetBranch}`], { cwd: ROOT });
  run('git', ['push', remote, `refs/tags/${splitTag}:refs/tags/v${releaseVersion}`], { cwd: ROOT });
  log.ok(`已推送 ${targetBranch} 分支与 v${releaseVersion} tag`);
}

/**
 * 调用 Packagist API（格式依据 https://packagist.org/apidoc）。
 *
 * 三处容易搞错、且本次发布实测踩过的点：
 *
 * 1. 认证头是 `Authorization: Bearer USERNAME:API_TOKEN` —— 既不是 HTTP Basic
 *    的 base64，也不是早期文档里的 `?username=&apiToken=` query string。
 *    用错会被拒成 406「Missing or invalid payload」，看起来像 body 格式问题，
 *    实际是认证方式不被接受。
 * 2. create-package 与 update-package 的 body 字段**都叫 `repository`**。
 *    update-package 用 `url` 是错的（网上流传的旧 curl 示例仍这么写）。
 * 3. create-package 属于 UNSAFE 端点，只接受 main API token；若配置的是
 *    safe token，建包会失败，只能走 update-package 或到网页手动提交。
 *
 * token 只出现在请求头里、不进 URL，因此不会随错误消息或代理日志外泄。
 */
async function callPackagist(endpoint, username, token, payload) {
  try {
    const response = await fetch(`https://packagist.org/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${username}:${token}`,
      },
      body: JSON.stringify(payload),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (err) {
    // 只回传 err.name：部分实现的错误文本会带上请求头或 URL
    return { ok: false, status: 0, body: `network error (${err.name})` };
  }
}
