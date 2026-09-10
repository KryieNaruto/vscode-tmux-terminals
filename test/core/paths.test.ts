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
  it('与已有条目重名报错', () => {
    assert.notStrictEqual(validateName('paint-pc', existing), null);
  });
  it('重名判断区分大小写', () => {
    assert.strictEqual(validateName('PAINT-PC', existing), null);
  });
  it('名字两侧空白被忽略后再判重', () => {
    assert.notStrictEqual(validateName('  paint-pc  ', existing), null);
  });

  // 以下三条是「会话名改由 id 派生」后的解禁项。
  // 显示名不再进入 tmux 目标语法，故这些字符不再有技术风险。
  it('含冒号放行（显示名不再用作 tmux 目标）', () => {
    assert.strictEqual(validateName('a:b', existing), null);
  });
  it('含点号放行', () => {
    assert.strictEqual(validateName('build.android', existing), null);
  });
  it('纯数字放行（不再与 tmux 会话索引冲突）', () => {
    assert.strictEqual(validateName('123', existing), null);
  });

  // 换行仍须拒绝：会破坏 TreeView 的单行展示
  it('含换行报错', () => {
    assert.notStrictEqual(validateName('a\nb', existing), null);
  });
  it('含回车报错', () => {
    assert.notStrictEqual(validateName('a\rb', existing), null);
  });
});
