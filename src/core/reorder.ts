/**
 * 三级树的拖拽排序限定在「同一文件夹（同 cwd）」内。这个纯函数负责把
 * 组内的新顺序「回填」进全局顺序数组——组外 id 的相对顺序绝不改变。
 * 见 docs/superpowers/specs/2026-09-10-tree-hierarchy-design.md §5。
 *
 * allIds：当前全局顺序（= store.reorder 需要的完整数组）。
 * groupIds：属于目标文件夹的那些 id（allIds 的子序列，顺序取自 allIds）。
 * draggedIds：本次拖拽的 id（groupIds 的子集）。
 * targetId：落点 id（groupIds 内某个未被拖拽的 id），undefined = 落到组尾。
 */
export function reorderWithinGroup(
  allIds: readonly string[],
  groupIds: readonly string[],
  draggedIds: readonly string[],
  targetId: string | undefined,
): string[] {
  const remaining = groupIds.filter((id) => !draggedIds.includes(id));
  const at = targetId === undefined ? remaining.length : remaining.indexOf(targetId);
  const insertAt = at === -1 ? remaining.length : at;
  const newGroupOrder = [...remaining];
  newGroupOrder.splice(insertAt, 0, ...draggedIds);

  const queue = [...newGroupOrder];
  const groupSet = new Set(groupIds);
  return allIds.map((id) => (groupSet.has(id) ? queue.shift()! : id));
}
