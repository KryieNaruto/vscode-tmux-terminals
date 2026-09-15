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
  isRunningTitle,
  taskNameFromTitle,
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

  it('占位符「Claude Code」返回空串（无论运行中还是空闲）', () => {
    assert.strictEqual(taskNameFromTitle('✳ Claude Code'), '');
    assert.strictEqual(taskNameFromTitle('⠐ Claude Code'), '');
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
