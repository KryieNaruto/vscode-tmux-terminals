import * as assert from 'assert';
import {
  sessionTarget,
  paneTarget,
  parseSessionList,
  shellQuote,
  isShellReady,
  sessionNameFor,
  escapeSessionName,
  parseAttachedCount,
  parsePid,
  SESSION_PREFIX,
  DEFAULT_TASK_TITLE,
  isRunningTitle,
  taskNameFromTitle,
  PANE_SAMPLE_SEPARATOR,
  parsePaneSample,
  taskNameFromSample,
  stripVolatileChrome,
  cursorRowAfterStrip,
  hasPendingBackgroundWork,
} from '../../src/core/tmux';

describe('sessionNameFor / escapeSessionName', () => {
  it('会话名由 id 派生并带固定前缀', () => {
    assert.strictEqual(sessionNameFor('a1b2c3'), SESSION_PREFIX + 'a1b2c3');
  });
  it('派生出的名字通过格式守卫', () => {
    assert.strictEqual(escapeSessionName(sessionNameFor('deadbeef1234')), true);
  });
  it('守卫拒绝含换行的名字（回归：会解析出幽灵会话）', () => {
    assert.strictEqual(escapeSessionName('tmuxterm-a\nb'), false);
  });
  it('守卫拒绝含冒号/点号/纯数字的名字', () => {
    assert.strictEqual(escapeSessionName('tmuxterm-a:b'), false);
    assert.strictEqual(escapeSessionName('tmuxterm-a.b'), false);
    assert.strictEqual(escapeSessionName('123'), false);
  });
  it('守卫拒绝没有前缀的名字', () => {
    assert.strictEqual(escapeSessionName('paint-pc'), false);
  });
  it('关键：用户能起出含换行的显示名，但派生出的会话名不含换行', () => {
    // 回归此前的 bug —— 显示名曾是会话名，tmux 允许换行，导致
    // parseSessionList 把一个会话切成两行、凭空多出一个幽灵会话
    const hostileDisplayName = 'evil\nghost';
    const derived = sessionNameFor('abc123');
    assert.strictEqual(hostileDisplayName.includes('\n'), true);
    assert.strictEqual(derived.includes('\n'), false);
    assert.deepStrictEqual(parseSessionList(derived + '\n'), [derived]);
  });
});

describe('sessionTarget / paneTarget', () => {
  it('session 目标加 = 前缀强制精确匹配', () => {
    assert.strictEqual(sessionTarget('build'), '=build');
  });
  it('pane 目标加 = 前缀且带冒号', () => {
    assert.strictEqual(paneTarget('build'), '=build:');
  });
  it('名字里有空格也照样处理', () => {
    assert.strictEqual(sessionTarget('my build'), '=my build');
    assert.strictEqual(paneTarget('my build'), '=my build:');
  });
});

describe('parseSessionList', () => {
  it('解析常规多行输出', () => {
    assert.deepStrictEqual(parseSessionList('0\n1\n2\n'), ['0', '1', '2']);
  });
  it('空输出返回空数组', () => {
    assert.deepStrictEqual(parseSessionList(''), []);
  });
  it('只有换行也返回空数组', () => {
    assert.deepStrictEqual(parseSessionList('\n'), []);
  });
  it('保留含空格的会话名为整行', () => {
    assert.deepStrictEqual(parseSessionList('my build\nother\n'), ['my build', 'other']);
  });
  it('忽略多余空白行', () => {
    assert.deepStrictEqual(parseSessionList('a\n\n\nb\n'), ['a', 'b']);
  });
  it('去掉行尾回车（CRLF 容忍）', () => {
    assert.deepStrictEqual(parseSessionList('a\r\nb\r\n'), ['a', 'b']);
  });
});

describe('shellQuote', () => {
  it('普通字符串包一层单引号', () => {
    assert.strictEqual(shellQuote('paint-pc'), "'paint-pc'");
  });
  it('单引号被正确转义', () => {
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
  });
  it('美元符被保护', () => {
    assert.strictEqual(shellQuote('$HOME'), "'$HOME'");
  });
  it('空格被保护', () => {
    assert.strictEqual(shellQuote('a b'), "'a b'");
  });
  it('中文被保护', () => {
    assert.strictEqual(shellQuote('中文 名'), "'中文 名'");
  });
  it('空串得到一对空单引号', () => {
    assert.strictEqual(shellQuote(''), "''");
  });
  it('反引号被保护', () => {
    assert.strictEqual(shellQuote('x`y'), "'x`y'");
  });
});

describe('isShellReady', () => {
  it('识别常见登录 shell', () => {
    for (const s of ['bash', 'zsh', 'sh', 'dash', 'fish']) {
      assert.strictEqual(isShellReady(s), true, s);
    }
  });
  it('识别带前导横杠的登录 shell（-bash）', () => {
    assert.strictEqual(isShellReady('-bash'), true);
  });
  it('识别带路径的 shell', () => {
    assert.strictEqual(isShellReady('/bin/bash'), true);
    assert.strictEqual(isShellReady('/usr/bin/zsh'), true);
  });
  it('把空串判为未就绪（关键：display-message 目标写错会静默返回空）', () => {
    assert.strictEqual(isShellReady(''), false);
    assert.strictEqual(isShellReady('   '), false);
  });
  it('把非 shell 前台进程判为未就绪', () => {
    assert.strictEqual(isShellReady('sleep'), false);
    assert.strictEqual(isShellReady('claude'), false);
    assert.strictEqual(isShellReady('vim'), false);
  });
});

describe('parseAttachedCount', () => {
  it('解析出附着客户端数', () => {
    assert.strictEqual(parseAttachedCount('0'), 0);
    assert.strictEqual(parseAttachedCount('1'), 1);
    assert.strictEqual(parseAttachedCount('12'), 12);
  });
  it('容忍尾部换行/空白（execFile 的 stdout 原样）', () => {
    assert.strictEqual(parseAttachedCount('1\n'), 1);
    assert.strictEqual(parseAttachedCount('  3  \n'), 3);
  });
  it('关键：空输出必须是 null（未知），不能当 0', () => {
    // display-message 的 pane 目标漏冒号时 tmux 是 exit 0 + 空输出，
    // 静默失败。当成 0 会让「已经附着」被误判为「没人附着」，
    // 于是每次点击都重复 attach；反过来当成 1 更糟，会漏掉真正的恢复。
    assert.strictEqual(parseAttachedCount(''), null);
    assert.strictEqual(parseAttachedCount('\n'), null);
    assert.strictEqual(parseAttachedCount('   '), null);
  });
  it('非数字输出一律 null（读取失败 / 格式被改）', () => {
    assert.strictEqual(parseAttachedCount('abc'), null);
    assert.strictEqual(parseAttachedCount('1.5'), null);
    assert.strictEqual(parseAttachedCount('-1'), null);
    assert.strictEqual(parseAttachedCount('1 2'), null);
  });
});

describe('isRunningTitle', () => {
  it('Braille 指示符判为运行中', () => {
    assert.strictEqual(isRunningTitle('⠐ VSCode 终端会话管理插件'), true);
    assert.strictEqual(isRunningTitle('⠂ Claude Code'), true);
  });
  it('普通符号判为空闲', () => {
    assert.strictEqual(isRunningTitle('✳ Claude Code'), false);
    assert.strictEqual(isRunningTitle('✳ 继续 Krita MSVC 编译工程'), false);
  });
  it('容忍前导空白', () => {
    assert.strictEqual(isRunningTitle('  ⠐ 任务'), true);
  });
  it('空串/纯空白判为空闲（关键：display-message 目标写错会静默返回空）', () => {
    assert.strictEqual(isRunningTitle(''), false);
    assert.strictEqual(isRunningTitle('   '), false);
  });
  it('只看首字符，字符串其余部分出现 Braille 字符不算', () => {
    assert.strictEqual(isRunningTitle('✳ 含有 ⠐ 字符的任务名'), false);
  });
});

describe('taskNameFromTitle —— 只在首码点确实是指示符时才剥', () => {
  it('Braille / ✳ 指示符后被剥掉，取出具体任务名', () => {
    assert.strictEqual(taskNameFromTitle('⠐ 创建多引擎版 /ask 命令并统一'), '创建多引擎版 /ask 命令并统一');
    assert.strictEqual(taskNameFromTitle('✳ 继续 Krita MSVC 编译工程'), '继续 Krita MSVC 编译工程');
    assert.strictEqual(taskNameFromTitle('⠐ VSCode 终端会话管理插件'), 'VSCode 终端会话管理插件');
  });

  it(`占位符「${DEFAULT_TASK_TITLE}」返回空串（无论运行中还是空闲）`, () => {
    // 用源码常量插值而不是手写字符串：占位符一旦改名（claude 改文案），
    // 这条测试必须跟着动，而不是继续对着一个已经不存在的老字符串常绿。
    assert.strictEqual(taskNameFromTitle(`✳ ${DEFAULT_TASK_TITLE}`), '');
    assert.strictEqual(taskNameFromTitle(`⠐ ${DEFAULT_TASK_TITLE}`), '');
  });

  it('只有指示符没有文字时返回空串', () => {
    assert.strictEqual(taskNameFromTitle('✳'), '');
    assert.strictEqual(taskNameFromTitle('✳ '), '');
  });

  it('★ 首码点是字母/数字时绝不剥 —— shell 自己设的标题必须原样保留', () => {
    // 回归：claude 退出后 bash 把 title 设成 user@host:cwd，原实现无条件
    // slice(1) 把它削成了 `iansenwei@H:~/workspace`
    assert.strictEqual(taskNameFromTitle('<username>@H:~/workspace'), '<username>@H:~/workspace');
    // 连 `bash` 都会被削成 `ash`
    assert.strictEqual(taskNameFromTitle('bash'), 'bash');
  });

  it('★ 首码点是标点（非字母数字）时同样绝不剥 —— 只有「指示符 + 空白」才是指示符', () => {
    // 回归：`!isLetterOrDigit` 这个否定式判据会把任何标点开头也当成指示符，
    // 于是 `-bash` 被削成 `bash`、`/home/user` 被削成 `home/user` ——
    // 与「首码点是字母」是同一类 bug，只是更窄。故再要求指示符后必须
    // 跟空白（或本身就是串尾）才剥。
    assert.strictEqual(taskNameFromTitle('-bash'), '-bash');
    assert.strictEqual(taskNameFromTitle('~/proj'), '~/proj');
    assert.strictEqual(taskNameFromTitle('/home/user'), '/home/user');
  });

  it('空串 / 纯空白返回空串', () => {
    assert.strictEqual(taskNameFromTitle(''), '');
    assert.strictEqual(taskNameFromTitle('   '), '');
  });
});

describe('parsePid —— 解析 `#{pane_pid}`', () => {
  it('解析出数字 pid', () => {
    assert.strictEqual(parsePid('287661'), 287661);
    assert.strictEqual(parsePid('  287661  \n'), 287661);
  });

  it('★ 空串 → null（display-message 目标写错时是 exit 0 + 空输出，静默失败）', () => {
    assert.strictEqual(parsePid(''), null);
    assert.strictEqual(parsePid('\n'), null);
    assert.strictEqual(parsePid('   '), null);
  });

  it('非数字 / 负数一律 null（读取失败或格式被改）', () => {
    assert.strictEqual(parsePid('abc'), null);
    assert.strictEqual(parsePid('-1'), null);
    assert.strictEqual(parsePid('1.5'), null);
    assert.strictEqual(parsePid('1 2'), null);
  });
});

describe('parsePaneSample —— 一次 display-message 拆出前台命令与标题', () => {
  const raw = (
    foreground: string,
    width: string | number,
    height: string | number,
    cursorY: string | number,
    title: string,
  ): string =>
    `${foreground}${PANE_SAMPLE_SEPARATOR}${width}${PANE_SAMPLE_SEPARATOR}${height}${PANE_SAMPLE_SEPARATOR}${cursorY}${PANE_SAMPLE_SEPARATOR}${title}`;

  it('分隔符是可打印定串（控制字符会被 tmux 转义成八进制字面量，见常量注释）', () => {
    assert.strictEqual(PANE_SAMPLE_SEPARATOR, '__tmuxterm_field_sep__');
    // 控制字符当分隔符在这里不管用：实测 tmux 3.4 的 display-message -p 会把
    // 格式串里的 0x1F 转义成四个可打印字符 `\037`，那个字节到不了输出里。
    assert.strictEqual(/[\x00-\x1f\x7f]/.test(PANE_SAMPLE_SEPARATOR), false);
    assert.ok(PANE_SAMPLE_SEPARATOR.length >= 8, '太短会撞上真进程名');
  });

  it('拆出五个字段（并吃掉 tmux 输出末尾的换行）', () => {
    assert.deepStrictEqual(parsePaneSample(raw('claude', 231, 72, 5, '⠐ 编译内核') + '\n'),
      { foreground: 'claude', width: 231, height: 72, cursorY: 5, title: '⠐ 编译内核' });
  });

  it('★ 正常五段输入解析出正确的宽高（纯数字 → Number，不是字符串）', () => {
    const sample = parsePaneSample(raw('claude', 200, 60, 0, '⠐ 编译内核'));
    assert.strictEqual(sample.width, 200);
    assert.strictEqual(sample.height, 60);
    assert.strictEqual(typeof sample.width, 'number');
    assert.strictEqual(typeof sample.height, 'number');
  });

  it('任一侧为空串时另一侧仍各归各位', () => {
    assert.deepStrictEqual(parsePaneSample(raw('bash', 231, 72, 5, '')),
      { foreground: 'bash', width: 231, height: 72, cursorY: 5, title: '' });
    assert.deepStrictEqual(parsePaneSample(raw('', 231, 72, 5, 'some title')),
      { foreground: '', width: 231, height: 72, cursorY: 5, title: 'some title' });
  });

  it('★ 宽高非数字（空串 / abc）→ 0（未知），不是 NaN、也不抛错', () => {
    // 空串/非数字一律 0，绝不给 NaN —— NaN 会污染下游所有比较，看似有值实则恒不等。
    for (const [w, h] of [['', 'abc'], ['abc', ''], ['12x', '3.5']] as const) {
      const sample = parsePaneSample(raw('claude', w, h, 5, '任务'));
      assert.strictEqual(sample.width, 0, `宽 "${w}" 应为 0`);
      assert.strictEqual(sample.height, 0, `高 "${h}" 应为 0`);
    }
  });

  it('★ 只按前四个分隔符切 —— 标题自带的同一个 token 也伤不到切分', () => {
    // 纵深防御：能破坏切分的只有「命令字段里含分隔符」（宽/高/光标行是纯数字、标题是尾字段）。
    // 按前四个切时，标题里多出来的 token 留在标题那一段里。
    assert.deepStrictEqual(parsePaneSample(raw('claude', 231, 72, 5, `a${PANE_SAMPLE_SEPARATOR}b`)),
      { foreground: 'claude', width: 231, height: 72, cursorY: 5, title: `a${PANE_SAMPLE_SEPARATOR}b` });
  });

  it('★ 畸形响应（空输出 / 缺任一分隔符）→ 五个字段全未知，不抛错也不把整串当标题', () => {
    // 空输出正是 display-message 的 pane 目标写错时的形态（exit 0 + 空）。
    // 若把整串当标题，那段「未知」会被下游当成一个真标题显示出来。
    // 缺后面的分隔符也要整个判未知 —— 不能把 `231` 当标题、也不能猜宽高/光标行。
    const missingSeps = `claude${PANE_SAMPLE_SEPARATOR}231${PANE_SAMPLE_SEPARATOR}72`;
    for (const bad of ['', '\n', '   ', 'bash', 'claude', missingSeps]) {
      assert.deepStrictEqual(parsePaneSample(bad),
        { foreground: '', width: 0, height: 0, cursorY: -1, title: '' },
        `畸形输入 ${JSON.stringify(bad)} 应判为五个字段都未知`);
    }
  });

  it('★ 解析出光标行：0 是有效值（不是未知），其余字段各归各位', () => {
    // 0 是合法的真实行号（光标停在 pane 第一行），必须按「已知」解析出来；
    // 若误当「未知」（-1），activityTracker 的「打字不算活动」判定会把第 0 行的
    // 打字漏判成活动，绿点照旧被点亮。这里同时压 0 与一个非 0 行号。
    assert.strictEqual(parsePaneSample(raw('claude', 231, 72, 0, '⠐ 任务')).cursorY, 0);
    const s = parsePaneSample(raw('claude', 231, 72, 7, '⠐ 任务'));
    assert.strictEqual(s.cursorY, 7);
    assert.strictEqual(s.width, 231);
    assert.strictEqual(s.height, 72);
    assert.strictEqual(s.title, '⠐ 任务');
  });

  it('★ 光标行缺失/非数字 → -1（未知），其余字段仍按现有规则解析', () => {
    // 沿用上面「坏输入」用例的风格：光标行一格坏掉只影响它自己，不牵连前后字段。
    for (const badCursor of ['', 'abc', '1.5', '-1', '7x']) {
      const s = parsePaneSample(raw('claude', 231, 72, badCursor, '⠐ 任务'));
      assert.strictEqual(s.cursorY, -1, `光标行 "${badCursor}" 应为 -1（未知）`);
      assert.strictEqual(s.foreground, 'claude');
      assert.strictEqual(s.width, 231);
      assert.strictEqual(s.height, 72);
      assert.strictEqual(s.title, '⠐ 任务');
    }
  });
});

describe('stripVolatileChrome —— 剔掉自己会跳动的装饰行', () => {
  it('含 `90% context used` 的行被删掉', () => {
    const content = ['对话区第一行', '90% context used', '对话区第二行'].join('\n');
    assert.strictEqual(stripVolatileChrome(content), ['对话区第一行', '对话区第二行'].join('\n'));
  });

  it('含 `🧠 …/…k …% │ 💰 …` 的状态行被删掉', () => {
    const content = [
      '对话区第一行',
      '🤖 Opus 5 │ 🌿 main │ 🧠 162.2k/200.0k 81.1% │ 💰 $33.34 / 剩$241.71',
      '对话区第二行',
    ].join('\n');
    assert.strictEqual(stripVolatileChrome(content), ['对话区第一行', '对话区第二行'].join('\n'));
  });

  it('普通对话行 / 空行 / 含 `%` 但非装饰形状的行（`100% done`）都保留', () => {
    const content = ['普通对话行', '', '100% done'].join('\n');
    assert.strictEqual(stripVolatileChrome(content), content,
      '不匹配装饰特征的行一律原样保留，空行也不能被吃掉（会改变行结构）');
  });

  it('★ 只有装饰行被删后，其余行的顺序与内容逐行不变', () => {
    const content = [
      '第一行',
      '10% context used',
      '第二行',
      '🧠 1.0k/200.0k 1% │ 💰 $1.00',
      '第三行',
      '',
    ].join('\n');
    assert.strictEqual(stripVolatileChrome(content), ['第一行', '第二行', '第三行', ''].join('\n'));
  });

  it('输入行（`❯ …`）被删掉，无论后面有没有文字', () => {
    const content = ['对话区第一行', '❯ 你', '❯ 改成浮层居中，组合区放到行中间 30%', '对话区第二行'].join('\n');
    assert.strictEqual(stripVolatileChrome(content), ['对话区第一行', '对话区第二行'].join('\n'));
  });

  it('模式行（`⏵⏵ bypass permissions on …`）被删掉，带不带 `· ← 1 agent` 后缀都要剔', () => {
    const bare = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';
    const withAgent = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent';
    const content = ['对话区第一行', bare, withAgent, '对话区第二行'].join('\n');
    assert.strictEqual(stripVolatileChrome(content), ['对话区第一行', '对话区第二行'].join('\n'));
  });

  it('输入框边框被删掉；但只含少量连字符的对话行必须保留（反向对照，防正则扩大化）', () => {
    const border = '────────────────────';
    const indentedBorder = '   ────────────────────';
    const content = ['对话区第一行', border, indentedBorder, '对话区第二行'].join('\n');
    assert.strictEqual(stripVolatileChrome(content), ['对话区第一行', '对话区第二行'].join('\n'));

    // 对话区里出现的短横线行不是边框，必须原样留着
    const keep = ['── 分隔 ──', 'a─b'].join('\n');
    assert.strictEqual(stripVolatileChrome(keep), keep);
  });

  it('★ 带任务标题的输入框边框也必须剔掉（标题异步落地不能算活动）', () => {
    // 任务结束后 claude 才把任务标题写进上边框；这行不变的话差分就把它当成
    // 新活动 ⇒ 已完成的槽 5 秒后又变绿（2026-10-19 用户报的症状）。
    const titled = '─'.repeat(60) + ' expose-vulkan-objects ─';
    const content = ['对话区第一行', titled, '❯ ', '对话区第二行'].join('\n');
    assert.strictEqual(stripVolatileChrome(content), ['对话区第一行', '对话区第二行'].join('\n'));
    // 反向对照：正文里 2 个连字符的分隔行不能被误删（旧测试已覆盖，这里再钉一次）
    const keep = '── 分隔 ──';
    assert.strictEqual(stripVolatileChrome(keep), keep);
  });

  it('★ 反向对照：忙碌转轮行 / 子 agent 进度行 / 普通对话行 / 空行都必须保留', () => {
    // 这四条是修本次 bug 时**不能误伤**的真信号 —— 没有它，扩大正则（比如把
    // 所有含 `(` 或含 `→` 的行都剔掉）也会让上一条「输入行被剔」常绿。
    const content = [
      '✻ Bunning… (2m 38s · ↓ 25.1k tokens · thinking)',
      '◯ deepseek-coder  改矩阵用例到新插入语义',
      '普通对话行',
      '',
    ].join('\n');
    assert.strictEqual(stripVolatileChrome(content), content,
      '真在干活的行一律原样保留，空行也不能被吃掉');
  });

  it('★ 端到端复现本次残余假绿：只有输入行 + 模式行在响 19:02:11 那对形态，剔除后必须完全相等', () => {
    // 2026-10-13 空闲会话 tmuxterm-010db8e2f02c 的 19:02:11，只有两行来回切：
    //   sL68  输入行   "❯ 改成浮层居中，组合区放到行中间 30%"  <->  "❯ 你"
    //   sL70  模式行   "… · ← 1 agent"                        <->  "…（无后缀）"
    // 两行都不匹配旧正则 → 被当成对话区有新内容 → running → 5 秒后落绿。
    // 剔除这四类界面行后，前后两拍的内容必须**逐字节相等**（= 差分判「没变」）。
    const before = [
      '对话区第一行',
      '❯ 改成浮层居中，组合区放到行中间 30%',
      '────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
      '对话区第二行',
    ].join('\n');
    const after = [
      '对话区第一行',
      '❯ 你',
      '────────────────────',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      '对话区第二行',
    ].join('\n');
    assert.strictEqual(stripVolatileChrome(before), stripVolatileChrome(after),
      '只有输入行 / 模式行在变时，剔除后必须完全相等，差分才不会误判有新内容');
  });

  it('★ /clear 提示行被剔掉，同样长度的空白行不算它', () => {
    // 输入框下方那行提示会在「有内容」和「整行全是空格」之间来回闪：
    //   有内容态：`       new task? /clear to save 411.9k tokens`
    //   空白态  ：同长度的一行空格
    // 只把「有内容」那一态按特征剔掉即可，空白态本就不含该特征。
    const withClear = '       new task? /clear to save 411.9k tokens';
    assert.strictEqual(stripVolatileChrome(withClear).includes('new task?'), false);
    assert.strictEqual(stripVolatileChrome('').includes('new task?'), false);
  });

  it('★ 菜单提示行被剔掉（带/不带 ctrl+g 后缀都剔）', () => {
    // 交互式菜单（AskUserQuestion）的提示行会在两态之间闪：多出 / 少了
    // `ctrl+g to edit in Vim`。两条都必须剔成同一个结果，差分才不会误判。
    const withoutVim = 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel';
    const withVim =
      'Enter to select · Tab/Arrow keys to navigate · ctrl+g to edit in Vim · Esc to cancel';
    assert.strictEqual(stripVolatileChrome(withoutVim), stripVolatileChrome(withVim),
      '两态剔除后必须相等，否则这行自跳会被当成对话区新内容');
  });

  it('★ 菜单提示行的第三种拼法（↑/↓ + n to add notes + Tab to switch questions）也被剔掉', () => {
    // 实测第三种拼法：`Tab` 出现在**后半段**（`Tab to switch questions`），
    // 按 `Tab/Arrow keys` 匹配必漏 —— 所以只认共同前缀 `Enter to select · `。
    const third =
      'Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel';
    assert.strictEqual(stripVolatileChrome(third), stripVolatileChrome(''),
      '提示行在有/无之间闪不该算内容变化：两态剔除后必须相等');
    assert.strictEqual(stripVolatileChrome(third).includes('Enter to select'), false);

    // 反向对照：`Tab to switch questions` 单独成行（不带 `Enter to select · ` 前缀）
    // 必须原样保留 —— 证明匹配的是完整前缀，而不是 `Tab` 这种宽词。
    const optionOnly = 'Tab to switch questions';
    assert.strictEqual(stripVolatileChrome(optionOnly), optionOnly);
  });

  it('菜单选项正文不被误剔', () => {
    // 反向对照：普通的菜单选项行 / 单词行不含完整提示行特征，必须原样保留。
    const content = ['  2. 父勾选级联子层 + 半选态', 'Enter'].join('\n');
    assert.strictEqual(stripVolatileChrome(content), content);
  });
});

describe('stripVolatileChrome —— 右下角状态提示行是「清空」不是「删行」', () => {
  // 这一族提示行的另一态是**同一位置的空行**：删行会让内容少一行、基线里那行
  // 空行还在，差异依然存在。实测（3 对真实快照）：删行 0/64 有效、清空 4/64 有效。
  // 所以下面每条都断言「行数不变 + 该行变成空串」，而不是「该行消失」。
  const INDENT = '                    '; // 实测第 24 行的右对齐缩进（> 4 个空格）

  // 全量回放 7711 对变化快照后，只有这三条会「整对变化完全只由它构成」（纯假绿）。
  const HINTS = [
    'Auto-updating…',
    '✔ Update installed · Restart to apply',
    '● high · /effort',
  ] as const;

  for (const hint of HINTS) {
    it(`★ ${hint} 被清空成空行（行数不变），与「同一位置空行」那一态逐字节相等`, () => {
      const shown = ['对话区第一行', INDENT + hint, '对话区第二行'].join('\n');
      const blank = ['对话区第一行', '', '对话区第二行'].join('\n'); // 闪烁的另一态
      const lines = stripVolatileChrome(shown).split('\n');
      // ① 清空（不是删行）：去掉 map 那一步，lines[1] 仍是原文 ⇒ 本行红；
      //    若有人改用 filter 删行，行数会变 2 ⇒ 上一行红。
      assert.strictEqual(lines.length, 3, '行数必须不变 —— 删行会让闪烁前后错位、差分依然不等');
      assert.strictEqual(lines[1], '', '提示行被清成空串');
      // ② 两态清空后逐字节相等 —— 差分才不会把这一下闪烁当成对话区变化。
      assert.strictEqual(stripVolatileChrome(shown), stripVolatileChrome(blank));
    });
  }

  it('★ 反向对照（过度剔除）：`10% until auto-compact` / `Notes: press n to add notes` 必须原样保留', () => {
    // 这两条在回放里**从不单独变化**（永远伴随真活动），剔了会丢真信号，绝不能清空。
    // 同一条用例里放一个真提示行作正向前提：去掉清空那步，lines[0] 会红。
    const content = [
      INDENT + 'Auto-updating…', // 真提示行：必须被清空
      INDENT + '10% until auto-compact', // 不是提示行：必须保留
      INDENT + 'Notes: press n to add notes', // 不是提示行：必须保留
    ].join('\n');
    const lines = stripVolatileChrome(content).split('\n');
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0], '', '真提示行仍要被清空（去掉清空那步本行会红）');
    assert.strictEqual(lines[1], INDENT + '10% until auto-compact',
      '这两条永远伴随真活动，一旦被清空说明正则扩过头了 —— 本行守这条');
    assert.strictEqual(lines[2], INDENT + 'Notes: press n to add notes');
  });

  it('★ 反向对照（锚定生效）：右对齐的被清空，左对齐的同样字样必须原样保留', () => {
    // 行首 `\s{4,}` 只为认「右对齐的提示行」；正文里回显这些字样（无缩进）不能误伤。
    // 正向前提：右对齐那条要被清空 —— 去掉清空那步，lines[0] 会红。
    const content = [
      INDENT + '✔ Update installed · Restart to apply', // 右对齐 → 清空
      '✔ Update installed · Restart to apply', // 左对齐（正文回显）→ 保留
    ].join('\n');
    const lines = stripVolatileChrome(content).split('\n');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], '', '右对齐的提示行必须被清空');
    assert.strictEqual(lines[1], '✔ Update installed · Restart to apply',
      '行首没有 ≥4 空格缩进 ⇒ 不能被清空（\\s{4,} 锚定生效）');
  });
});

describe('taskNameFromSample —— pane 前台不是 claude 就不采信 pane title', () => {
  // 尺寸与任务名无关，这里给固定非零值让 PaneSample 成立（宽高不参与本 describe 的判定）。
  const s = (foreground: string, title: string) => ({ foreground, title, width: 231, height: 72, cursorY: 0 });

  it('★ 前台不是 claude 时，shell 提示符形状的标题一律不算任务名', () => {
    // 本次新增的闸门，也是本任务的核心：claude 退出后 pane 前台变回 shell，
    // 标题成了 `user@host:~/path`。改前这条链（taskNameFromTitle）会原样
    // 保留它（同一输入在 test/core/tmux.test.ts 的 taskNameFromTitle 一节
    // 有断言，正是「保留」），于是三级显示提示符、aiTitle 回退永远轮不到。
    for (const shell of ['bash', '-bash', 'sh', 'zsh', 'nvim', 'node']) {
      assert.strictEqual(
        taskNameFromSample(s(shell, '<username>@H:~/workspace')), '',
        `前台是 ${shell} 时不应采信 pane title`);
    }
  });

  // 回归护栏，**不是**判别性断言：这两个输入在改前（对 title 直接调
  // taskNameFromTitle）本来就返回 ''，所以它在「拆掉闸门」的变异下照样绿。
  // 它守的是「闸门没顺手把占位符/空标题变成别的值」这件事，别拿它去证明闸门存在。
  it('前台不是 claude 时，占位符与空标题同样不算任务名', () => {
    assert.strictEqual(taskNameFromSample(s('bash', `✳ ${DEFAULT_TASK_TITLE}`)), '');
    assert.strictEqual(taskNameFromSample(s('bash', '')), '');
  });

  it('前台是 claude：照旧取出标题里的任务名（含剥掉 ⠐ 指示符）', () => {
    assert.strictEqual(
      taskNameFromSample(s('claude', '⠐ 创建多引擎版 /ask 命令并统一')),
      '创建多引擎版 /ask 命令并统一');
    assert.strictEqual(
      taskNameFromSample(s('/usr/local/bin/claude', '✳ 继续 Krita MSVC 编译工程')),
      '继续 Krita MSVC 编译工程');
  });

  it('前台是 claude 但标题只是占位符/空 → 空串（与改前一致，交给 aiTitle 回退）', () => {
    assert.strictEqual(taskNameFromSample(s('claude', `✳ ${DEFAULT_TASK_TITLE}`)), '');
    assert.strictEqual(taskNameFromSample(s('claude', '⠐')), '');
    assert.strictEqual(taskNameFromSample(s('claude', '')), '');
  });

  it('★ 采样未知（畸形响应）→ 空串，不退化成显示什么', () => {
    assert.strictEqual(taskNameFromSample({ foreground: '', title: '', width: 0, height: 0, cursorY: -1 }), '');
    // 未知前台 + 一段看似任务名的标题：不能因为「标题好看」就采信
    assert.strictEqual(taskNameFromSample(s('', '创建多引擎版 /ask 命令并统一')), '');
  });
});

describe('hasPendingBackgroundWork —— 还有未完成的后台工作', () => {
  it('★ 命中 Waiting for 1 background agent to finish', () => {
    // 真实形态：多行 pane 内容里夹着这一行忙碌行。旁边放一行普通对话，
    // 证明匹配的是「那一行」而不是整串撞上。
    const content = [
      '对话区第一行',
      '✻ Waiting for 1 background agent to finish',
      '对话区第二行',
    ].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), true);
  });

  it('后台 agent 数大于 1 也命中', () => {
    const content = ['对话区第一行', '✻ Waiting for 2 background agents to finish'].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), true);
  });

  it('★ 反向对照：空闲 pane 不命中', () => {
    // `✻ Brewed for 2m 24s` 是「干完了」的过去式行；空闲 pane 里没有等待行。
    const content = [
      '对话区第一行',
      '✻ Brewed for 2m 24s',
      '对话区第二行',
    ].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), false);
  });

  it('区分大小写/形状：Waiting for something to finish 不命中', () => {
    // 必须是 `Waiting for <数字> background agent`，不是任意 `Waiting for … to finish`。
    assert.strictEqual(hasPendingBackgroundWork('✻ Waiting for the user to finish'), false);
  });

  it('★ 反向对照：正文里引用这句话不算「后台还有活」', () => {
    // 实测那一整行原文：一个 claude 会话正在讨论本功能，它自己的消息正文被回显在
    // pane 里，正文中引用了忙碌行原文。不锚定行首的话这一行会命中 ⇒ 那个其实空闲的
    // pane 被永久判成 running（转圈不停、再也不落绿），是个真实的永久转圈 bug。
    const content =
      '● Waiting for 的扫描里有个我没料到的形态：我自己这条会话的消息正文被回显在 pane 里（表格里引用了 ✻ Waiting for 1 background agent to finish 的原文）';
    assert.strictEqual(hasPendingBackgroundWork(content), false);
  });

  it('反向对照：diff 前缀行（+ / - 开头）不命中', () => {
    // 行首是 `+` / `-` 后跟两个空格再跟转轮字符：`\S\s+` 只吃「一个非空白 + 一段空白」，
    // 于是 `+` 之后紧跟的第二个非空白字符（转轮字符）让整条不匹配 ⇒ 不命中。
    const content = [
      '+  ✻ Waiting for 1 background agent to finish',
      '-  ✻ Waiting for 1 background agent to finish',
    ].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), false);
  });

  it('★ 行首锚定：忙碌行单独成行仍然命中', () => {
    // 收紧后不能把真信号弄丢：整行形态（行首转轮字符 + 空格 + Waiting …）仍要命中。
    assert.strictEqual(hasPendingBackgroundWork('✻ Waiting for 2 background agents to finish'), true);
  });

  // ---- 2026-10-13：改成「只测活状态行」后的用例（下方是 claude TUI 的固定底部结构）----
  // 底部固定形态：活状态行(距底 7~10 行) / 空格填充行 / 上边框 / ❯ 输入行 / 下边框 /
  // 模型-分支-钱行 / 模式行。用常量拼出来，方便看清行结构。
  const BORDER = '────────────────────────────────────────────────────────────────────────────────────────────────';
  const FILLER = ' '.repeat(96); // 状态行与边框之间的纯空格填充行（原样保留，trim 后为空 ⇒ 跳过的正是它）
  const INPUT = '❯ ';
  const STATUS_ROW =
    '  🤖 deepseek-v4-flash │ 🌿 strip-qt-ui │ 🧠 411.3k/? │ 💰 $60.86 / 剩$136.65 │ <username>@vendor-dev';
  const MODE_ROW = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent';
  // claude 2.1.x 实测的上边框形态：标题夹在连字符之间（尾巴上还剩 1 个 `─`）。
  const TITLED_BORDER = '─'.repeat(60) + ' expose-vulkan-objects ─';

  it('★ 回归主用例：残留等待行在活区之外 ⇒ 不命中（旧实现下必挂）', () => {
    // 2026-10-13 实测：槽 tmuxterm-7e54badec0d4 假转圈，两拍内容逐字节相同。
    // claude 结束等待时把「✻ Waiting for …」原样印进了正文，永久留在屏上第 37 行，
    // 紧接着就是「● Agent … finished · 26s」（已完成），当前真实的活状态行是「✻ Brewed …」（空闲）。
    // 残留行距底部只有 3 条非空行 —— 它同时否掉「按行数截断（slice(-K)）」的偷懒写法。
    const content = [
      '  收尾时我又踩了一次 pgrep -af | kill（模式匹配到我自己那条 shell，自杀了，exit 144）',
      '',
      '✻ Waiting for 1 background agent to finish', // ← 正文里的残留副本（旧口径命中的就是它）
      '',
      '● Agent "提交推送朝向根因订正" finished · 26s',
      '✻ Brewed for 2m 24s', // ← 真正的活状态行（空闲）
      FILLER,
      BORDER,
      INPUT,
      BORDER,
      STATUS_ROW,
      MODE_ROW,
    ].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), false,
      '这条挂了意味着什么：判据又被正文里的残留等待行骗到 ⇒ 空闲槽永久转圈、永不落绿（本 bug 复现）');
  });

  it('★ 真在等的时候仍必须命中（防过度修正）', () => {
    // 同一个底部结构，只把活状态行换成等待行 —— 不能为了消假转圈把真转圈一起消掉。
    const content = [
      '对话区第一行',
      '● Agent "提交推送朝向根因订正" finished · 26s',
      '✻ Waiting for 1 background agent to finish', // ← 活状态行（真在等）
      FILLER,
      BORDER,
      INPUT,
      BORDER,
      STATUS_ROW,
      MODE_ROW,
    ].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), true,
      '这条挂了意味着什么：真在等后台 agent 的槽被漏判成空闲 ⇒ 老终端误变绿');
  });

  it('★ 提示行夹在状态行与边框之间时不漏判（复数 agents 仍被认）', () => {
    // 实测底部还夹着一族提示行（Auto-updating… 等），会出现在状态行与边框之间；
    // 活区取 2 条才能同时覆盖「状态行」和「夹在中间的那条提示行」。
    const content = [
      '对话区第一行',
      '✻ Waiting for 2 background agents to finish',
      '                    Auto-updating…', // 更靠近边框的提示行
      FILLER,
      BORDER,
      INPUT,
      BORDER,
      STATUS_ROW,
      MODE_ROW,
    ].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), true,
      '这条挂了意味着什么：活区只取 1 条时，状态行会被夹在中间的提示行挤出活区 ⇒ 真转圈被漏判');
  });

  it('定位不出结构时退回旧口径（搜全屏，安全侧）', () => {
    // 没有 ❯ 行（或没有边框行）⇒ liveStatusRegion 返回 null ⇒ 退回「搜全屏」。
    const content = ['对话区第一行', '✻ Waiting for 1 background agent to finish', '对话区第二行'].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), true,
      '这条挂了意味着什么：定位失败时宁可不判 running ⇒ 真信号被漏（安全侧反了）');
  });

  it('★ 带标题的输入框上边框仍能定位活区 ⇒ 正文残留等待行不命中', () => {
    // 实测（2026-10-19）：claude 2.1.x 的输入框上边框把任务标题嵌在连字符之间，
    // 旧正则（整行只有连字符）不匹配 ⇒ liveStatusRegion 返回 null ⇒ 退回全屏搜。
    // 下面这条残留行在正文里，真实活状态行是「✻ Worked for 7m 10s · done 3:53」。
    const content = [
      '✻ Waiting for 1 background agent to finish', // ← 正文残留副本（旧口径命中的就是它）
      '● Agent "提交推送朝向根因订正" finished · 26s',
      '',
      '✻ Worked for 7m 10s · done 3:53', // ← 真正的活状态行（已结束）
      FILLER,
      TITLED_BORDER,
      INPUT,
      BORDER,
      STATUS_ROW,
      MODE_ROW,
    ].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), false,
      '这条挂了意味着什么：带标题的边框定位不出活区 ⇒ 已完成的槽永久转圈（本 bug 复现）');
  });

  it('★ 带标题边框 + 真在等待 ⇒ 仍必须命中', () => {
    const content = [
      '对话区第一行',
      '✻ Waiting for 1 background agent to finish', // ← 活状态行（真在等）
      FILLER,
      TITLED_BORDER,
      INPUT,
      BORDER,
      STATUS_ROW,
      MODE_ROW,
    ].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), true,
      '这条挂了意味着什么：真在等后台 agent 的槽被漏判成空闲 ⇒ 老终端误变绿');
  });

  it('★ 纯正文引用不被误当等待（引用行在活区之外）', () => {
    // claude 的空闲 pane：活状态行是「✻ Baked …」，正文里有一整行引用。
    // 引用行距底部 ≥3 条非空行，落在活区之外 ⇒ 不命中（旧口径会命中它）。
    const content = [
      '✻ Waiting for 1 background agent to finish', // ← 正文里的整行引用（旧口径的假阳性来源）
      '● 上面这句是引用，不是活状态 —— 说明书里的「整行形态」也可能出现在正文里',
      '',
      '✻ Baked for 21m 44s', // ← 活状态行（空闲）
      FILLER,
      BORDER,
      INPUT,
      BORDER,
      STATUS_ROW,
      MODE_ROW,
    ].join('\n');
    assert.strictEqual(hasPendingBackgroundWork(content), false,
      '这条挂了意味着什么：正文里回显等待行又把空闲槽判成 running ⇒ 永久假转圈');
  });
});

describe('cursorRowAfterStrip —— 原始屏幕行号 → strip 后的行号', () => {
  // 回归（实测 2026-10-13）：activityTracker 的 changedLines 是 strip 坐标，而
  // s.cursorY 是原始行号，硬比会两头打偏 —— 正例里恒不触发、反例里误伤真活动。
  // 这个纯函数就是两者的桥。

  it('★ 光标之上没有任何被删行 ⇒ 恒等（原样返回行号）', () => {
    const content = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].join('\n');
    assert.strictEqual(cursorRowAfterStrip(content, 0), 0);
    assert.strictEqual(cursorRowAfterStrip(content, 5), 5);
  });

  it('★ 光标之上被删 2 行 ⇒ 行号 -2（复现 68→64 那类移位）', () => {
    const content = [
      'L0',                             // 0
      '🧠 1.0k/200.0k 1% │ 💰 $1.00',   // 1 状态行 → 删
      'L2',                             // 2
      '────────────────────',           // 3 边框 → 删
      'L4',                             // 4
      'L5',                             // 5 ← 光标
    ].join('\n');
    assert.strictEqual(cursorRowAfterStrip(content, 5), 3, '5 - 2 行被删 = 3');
  });

  it('★ 光标行自身命中删除规则（空的 ❯ 输入行）⇒ -1（未知，别猜相邻行）', () => {
    // 反例 pane tmuxterm-5179df5692a1：cursor_y 恰好指向被删的 `❯ ` 输入行，
    // 这一拍的差异根本不在 strip 后的内容里 —— 必须判未知，不能硬比。
    assert.strictEqual(cursorRowAfterStrip(['L0', '❯ 你', 'L2'].join('\n'), 1), -1);
  });

  it('★ 光标之上是「清空类提示行」⇒ 不移位（清空不删行，绝不能多减）', () => {
    // VOLATILE_HINTS 那一族被清成空串、**不删行**；若把它计入移位就会多减。
    const INDENT = '                    ';
    const content = [
      'L0',
      INDENT + 'Auto-updating…', // 提示行 → 清空，不移位
      'L2',
      'L3',                      // ← 光标
    ].join('\n');
    assert.strictEqual(cursorRowAfterStrip(content, 3), 3,
      '只有清空的提示行在光标之上：行号不变');
  });

  it('★ 未知/越界/非整数 ⇒ -1', () => {
    const content = ['L0', 'L1'].join('\n');
    assert.strictEqual(cursorRowAfterStrip(content, -1), -1, 'cursorY = -1 是 tmux 没给');
    assert.strictEqual(cursorRowAfterStrip(content, 2), -1, 'cursorY == 行数属越界');
    assert.strictEqual(cursorRowAfterStrip(content, 1.5), -1, '非整数不接受');
    assert.strictEqual(cursorRowAfterStrip('', 1), -1, '空内容只有 1 行，1 越界');
  });
});
