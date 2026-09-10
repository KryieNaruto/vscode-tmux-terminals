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

  it('到根仍冲突（全为 "/"）不死循环，返回非空且合理', () => {
    const out = shortLabels(['/', '/']);
    assert.deepStrictEqual(out, ['/', '/']);
  });

  // 回归：用户的真实数据形态 —— 3 条同处一个长目录、3 条同处一个短目录。
  // 逐字节相同的 cwd 无论怎么加长都不可能唯一，旧实现在此处退回**完整
  // 路径**（82 字符），把「短标签」这个功能整个反转。正确行为是退回
  // **basename**：同目录条目本来就靠行标签（条目名）区分。
  it('cwd 逐字节相同时退回 basename（短），绝不退回完整路径', () => {
    const LONG = '/ssd/qiansenwei/workspace/work/Krita_Linux_liyang/paint_workspace/tree/strip-qt-ui';
    const SHORT = '/ssd/qiansenwei/workspace';
    const cwds = [SHORT, SHORT, SHORT, LONG, LONG, LONG];

    const out = shortLabels(cwds);

    assert.deepStrictEqual(out, [
      'workspace', 'workspace', 'workspace',
      'strip-qt-ui', 'strip-qt-ui', 'strip-qt-ui',
    ]);
    // 每一条都必须是短 basename，且不得等于完整路径
    out.forEach((label, i) => {
      assert.notStrictEqual(label, cwds[i], `第 ${i} 条退回了完整路径`);
      assert.ok(label.length < cwds[i].length, `第 ${i} 条不够短：${label}`);
      assert.ok(!label.includes('/'), `第 ${i} 条仍含路径分隔符：${label}`);
    });
  });
});
