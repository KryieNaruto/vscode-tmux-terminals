import * as assert from 'assert';
import { expandHome, validateName } from '../../src/core/paths';

describe('expandHome', () => {
  const home = '/home/qiansenwei';
  it('单独的 ~ 展开为 home', () => {
    assert.strictEqual(expandHome('~', home), home);
  });
  it('~/x 展开为 home/x', () => {
    assert.strictEqual(expandHome('~/mine', home), '/home/qiansenwei/mine');
  });
  it('绝对路径原样返回', () => {
    assert.strictEqual(expandHome('/ssd/work', home), '/ssd/work');
  });
  it('相对路径原样返回', () => {
    assert.strictEqual(expandHome('mine/paint', home), 'mine/paint');
  });
  it('~user/x 原样返回（不解析他人 home）', () => {
    assert.strictEqual(expandHome('~other/x', home), '~other/x');
  });
  it('空串原样返回', () => {
    assert.strictEqual(expandHome('', home), '');
  });
  it('不误伤以 ~ 开头但非家目录的路径', () => {
    assert.strictEqual(expandHome('~abc', home), '~abc');
  });
});

describe('validateName', () => {
  const existing = ['paint-pc', 'krita-build'];

  it('合法名通过', () => {
    assert.strictEqual(validateName('new-one', existing), null);
  });
  it('空名报错', () => {
    assert.notStrictEqual(validateName('', existing), null);
  });
  it('全空白报错', () => {
    assert.notStrictEqual(validateName('   ', existing), null);
  });
  it('含冒号报错（与 tmux 的 session:window.pane 目标语法冲突）', () => {
    assert.notStrictEqual(validateName('a:b', existing), null);
  });
  it('含点号报错（同上）', () => {
    assert.notStrictEqual(validateName('a.b', existing), null);
  });
  it('纯数字报错（与 tmux 会话索引冲突）', () => {
    assert.notStrictEqual(validateName('123', existing), null);
  });
  it('与已有条目重名报错', () => {
    assert.notStrictEqual(validateName('paint-pc', existing), null);
  });
  it('重名判断区分大小写', () => {
    assert.strictEqual(validateName('PAINT-PC', existing), null);
  });
  it('名字两侧空白被忽略后再判重', () => {
    assert.notStrictEqual(validateName('  paint-pc  ', existing), null);
  });
});
