import * as assert from 'assert';
import { sessionTarget, paneTarget, parseSessionList, shellQuote, isShellReady } from '../../src/core/tmux';

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
