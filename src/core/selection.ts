/**
 * 批量面板里「文件夹（一级）」的选中态与点击语义。
 *
 * 纯函数、零 vscode（spec §11.14）。放进 core 的理由和 reconcile 一样：三态
 * 判定 + 「点一下补齐」这套语义只有这一份定义，且必须能脱离编辑器单测 ——
 * 写在 batchTree.ts 里就只能靠手动点面板来验。
 */

/**
 * 一个分组的选中态。
 * - `'none'`    ：组内没有任何一条被选中
 * - `'all'`     ：组内全部被选中
 * - `'partial'` ：部分选中
 *
 * **空数组按 `'none'` 处理**：空组不该显示成已选。判成 `'all'` 的后果是一个
 * 刚被删空的文件夹在面板上打着实心勾，用户点它却什么都不会发生 —— 而「全选」
 * 这个动作看起来已经生效了。
 *
 * 只按**组内 id** 看：集合里混着别的组的 id 不影响本组的三态（各组的判定
 * 互相独立，这是「组间互不干扰」这条需求的判据）。
 */
export function folderSelectionState(
  childIds: readonly string[],
  selected: ReadonlySet<string>,
): 'all' | 'none' | 'partial' {
  if (childIds.length === 0) return 'none';
  let hit = 0;
  for (const id of childIds) {
    if (selected.has(id)) hit++;
  }
  if (hit === 0) return 'none';
  return hit === childIds.length ? 'all' : 'partial';
}

/**
 * 点击文件夹标题后的**新选中集合**。
 *
 * `'all'` → 全不选（再点一次取消）；其余（`none` / `partial`）→ 全选。
 * 部分选中时点一下的意图是「补齐」而不是「清空」——这是列表类界面的通行
 * 语义，写反了会让用户为了补全一个大部分已选的组多点一次。
 *
 * **返回新集合，绝不原地改**：调用方拿它去算图标与命令参数，原地改会让
 * 「判定用的集合」与「渲染时的集合」永远是同一个对象，两次刷新之间看不出
 * 变化，面板上的勾就会停在旧状态。
 *
 * 组外的 id 原样带过（先复制、再只动组内那几条）：否则点一个文件夹会把
 * 别的组的选中一起清掉。
 */
export function toggleFolderSelection(
  childIds: readonly string[],
  selected: ReadonlySet<string>,
): Set<string> {
  const next = new Set(selected);
  if (folderSelectionState(childIds, selected) === 'all') {
    for (const id of childIds) next.delete(id);
  } else {
    for (const id of childIds) next.add(id);
  }
  return next;
}
