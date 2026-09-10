import * as assert from 'assert';
import { shortLabels } from '../../src/core/labels';

describe('shortLabels', () => {
  it('无冲突时用 basename', () => {
    assert.deepStrictEqual(shortLabels(['/a/b/one', '/a/b/two']), ['one', 'two']);
  });

  it('basename 冲突时补一层父目录', () => {
    assert.deepStrictEqual(
      shortLabels(['/ssd/q/w/workspace', '/home/x/workspace']),
      ['w/workspace', 'x/workspace'],
    );
  });

  it('补一层仍冲突时继续往上补', () => {
    assert.deepStrictEqual(shortLabels(['/a/x/w', '/b/x/w']), ['a/x/w', 'b/x/w']);
  });

  it('末尾斜杠正常处理', () => {
    assert.deepStrictEqual(shortLabels(['~/mine/paint-pc/']), ['paint-pc']);
  });

  it('等长同序，空数组返回空数组', () => {
    assert.deepStrictEqual(shortLabels([]), []);
    assert.strictEqual(shortLabels(['/a', '/b']).length, 2);
  });

  it('绝对路径到根仍冲突时返回完整路径，不死循环', () => {
    const out = shortLabels(['/', '/']);
    assert.strictEqual(out.length, 2);
    assert.ok(out.every((s) => typeof s === 'string' && s.length > 0));
  });
});
