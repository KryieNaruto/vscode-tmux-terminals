import * as assert from 'assert';
import { folderSelectionState, toggleFolderSelection } from '../../src/core/selection';

describe('folderSelectionState', () => {
  it('★ 空数组 → none（空组绝不显示成已选）', () => {
    // 判成 all 的后果：一个刚被删空的文件夹在面板上打着实心勾，用户点它
    // 却什么都不会发生；而「全选」这个动作本身看起来已生效。
    assert.strictEqual(folderSelectionState([], new Set(['x', 'y'])), 'none');
  });

  it('全部选中 → all', () => {
    assert.strictEqual(folderSelectionState(['a', 'b'], new Set(['a', 'b', 'c'])), 'all');
  });

  it('部分选中 → partial', () => {
    assert.strictEqual(folderSelectionState(['a', 'b'], new Set(['a'])), 'partial');
  });

  it('一个都没选中 → none', () => {
    assert.strictEqual(folderSelectionState(['a', 'b'], new Set()), 'none');
  });

  it('★ 集合里混有组外 id 不影响判定（只按组内 id 看）', () => {
    assert.strictEqual(folderSelectionState(['a', 'b'], new Set(['a', 'b', 'z'])), 'all');
    assert.strictEqual(folderSelectionState(['a', 'b'], new Set(['a', 'z'])), 'partial');
    assert.strictEqual(folderSelectionState(['a', 'b'], new Set(['z'])), 'none');
  });

  it('单个子项也按同一套判据', () => {
    assert.strictEqual(folderSelectionState(['a'], new Set(['a'])), 'all');
    assert.strictEqual(folderSelectionState(['a'], new Set()), 'none');
  });
});

describe('toggleFolderSelection', () => {
  it('all → 全不选（再点一次就是取消）', () => {
    const out = toggleFolderSelection(['a', 'b'], new Set(['a', 'b']));
    assert.deepStrictEqual([...out].sort(), []);
  });

  it('none → 全选', () => {
    const out = toggleFolderSelection(['a', 'b'], new Set());
    assert.deepStrictEqual([...out].sort(), ['a', 'b']);
  });

  it('★ partial → 全选（点一下的意图是「补齐」，不是「清空」）', () => {
    // 列表类界面的通行语义：部分选中时点文件夹标题 = 把剩下的补上。
    // 写反成「清空」的话，用户补全一个大部分已选的组要多点一次。
    const out = toggleFolderSelection(['a', 'b', 'c'], new Set(['a']));
    assert.deepStrictEqual([...out].sort(), ['a', 'b', 'c']);
  });

  it('★ 不改变组外 id 的选中态', () => {
    const out = toggleFolderSelection(['a', 'b'], new Set(['a', 'outsider']));
    assert.deepStrictEqual([...out].sort(), ['a', 'b', 'outsider']);
    const cleared = toggleFolderSelection(['a', 'b'], new Set(['a', 'b', 'outsider']));
    assert.deepStrictEqual([...cleared].sort(), ['outsider']);
  });

  it('★ 返回新集合，且不改动入参（纯函数）', () => {
    const input = new Set(['a']);
    const out = toggleFolderSelection(['a', 'b'], input);
    assert.notStrictEqual(out, input, '必须是新集合');
    assert.deepStrictEqual([...input], ['a'], '入参一个元素都不能变');
  });

  it('空组：无子项可加，返回的是一个等价的新集合而不是入参', () => {
    const input = new Set(['z']);
    const out = toggleFolderSelection([], input);
    assert.notStrictEqual(out, input);
    assert.deepStrictEqual([...out], ['z']);
  });
});
