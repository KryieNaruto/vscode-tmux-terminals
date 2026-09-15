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
    assert.strictEqual(taskNameFromTitle('qiansenwei@H:~/workspace'), 'qiansenwei@H:~/workspace');
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
  const raw = (foreground: string, title: string): string =>
    `${foreground}${PANE_SAMPLE_SEPARATOR}${title}`;

  it('分隔符是可打印定串（控制字符会被 tmux 转义成八进制字面量，见常量注释）', () => {
    assert.strictEqual(PANE_SAMPLE_SEPARATOR, '__tmuxterm_field_sep__');
    // 控制字符当分隔符在这里不管用：实测 tmux 3.4 的 display-message -p 会把
    // 格式串里的 0x1F 转义成四个可打印字符 `\037`，那个字节到不了输出里。
    assert.strictEqual(/[\x00-\x1f\x7f]/.test(PANE_SAMPLE_SEPARATOR), false);
    assert.ok(PANE_SAMPLE_SEPARATOR.length >= 8, '太短会撞上真进程名');
  });

  it('拆出两个字段（并吃掉 tmux 输出末尾的换行）', () => {
    assert.deepStrictEqual(parsePaneSample(raw('claude', '⠐ 编译内核') + '\n'),
      { foreground: 'claude', title: '⠐ 编译内核' });
  });

  it('任一侧为空串时另一侧仍各归各位', () => {
    assert.deepStrictEqual(parsePaneSample(raw('bash', '')),
      { foreground: 'bash', title: '' });
    assert.deepStrictEqual(parsePaneSample(raw('', 'some title')),
      { foreground: '', title: 'some title' });
  });

  it('★ 只按第一个分隔符切 —— 标题自带的同一个 token 也伤不到切分', () => {
    // 纵深防御：能破坏切分的只有「命令字段里含分隔符」（标题是尾字段）。
    // 按第一个切时，标题里多出来的 token 留在标题那一段里。
    assert.deepStrictEqual(parsePaneSample(raw('claude', `a${PANE_SAMPLE_SEPARATOR}b`)),
      { foreground: 'claude', title: `a${PANE_SAMPLE_SEPARATOR}b` });
  });

  it('★ 畸形响应（空输出 / 没有分隔符）→ 两个空串，不抛错也不把整串当标题', () => {
    // 空输出正是 display-message 的 pane 目标写错时的形态（exit 0 + 空）。
    // 若把整串当标题，那段「未知」会被下游当成一个真标题显示出来。
    for (const bad of ['', '\n', '   ', 'bash', 'claude']) {
      assert.deepStrictEqual(parsePaneSample(bad), { foreground: '', title: '' },
        `畸形输入 ${JSON.stringify(bad)} 应判为两个字段都未知`);
    }
  });
});

describe('taskNameFromSample —— pane 前台不是 claude 就不采信 pane title', () => {
  const s = (foreground: string, title: string) => ({ foreground, title });

  it('★ 前台不是 claude 时，shell 提示符形状的标题一律不算任务名', () => {
    // 本次新增的闸门，也是本任务的核心：claude 退出后 pane 前台变回 shell，
    // 标题成了 `user@host:~/path`。改前这条链（taskNameFromTitle）会原样
    // 保留它（同一输入在 test/core/tmux.test.ts 的 taskNameFromTitle 一节
    // 有断言，正是「保留」），于是三级显示提示符、aiTitle 回退永远轮不到。
    for (const shell of ['bash', '-bash', 'sh', 'zsh', 'nvim', 'node']) {
      assert.strictEqual(
        taskNameFromSample(s(shell, 'qiansenwei@H:~/workspace')), '',
        `前台是 ${shell} 时不应采信 pane title`);
    }
  });

  it('★ 前台不是 claude 时，占位符与空标题同样不算任务名', () => {
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
    assert.strictEqual(taskNameFromSample({ foreground: '', title: '' }), '');
    // 未知前台 + 一段看似任务名的标题：不能因为「标题好看」就采信
    assert.strictEqual(taskNameFromSample(s('', '创建多引擎版 /ask 命令并统一')), '');
  });
});
