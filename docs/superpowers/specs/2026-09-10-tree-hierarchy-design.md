# 三级树重构：文件夹 → 终端 → 任务名

日期：2026-09-10
状态：待用户评审
关联：`2026-09-10-tmux-terminals-v2-design.md`（本文件不改动其内容，是独立的一批需求）

## 1. 背景

v0.1.3 刚上线的「任务名徽章 + 闪烁 + 完成变绿」用的是单行 `TreeItemLabel.highlights`
做徽章、`ThemeIcon('loading~spin')` 做转圈。用户体验后提出四点新需求：

1. 任务名挪到终端名称下一行，作为下级标题
2. 能够切换 tmux 或者 bash
3. 布局改成三级：一级=文件夹路径，二级=终端名称，三级=任务名字
4. 任务名取消闪烁，改用转圈图标放在任务名前面

**第 2 点在澄清阶段被用户明确撤回**（"算了，不要这个模式了，需求点2去除"），
本文档只覆盖 1、3、4——而 1 和 4 在设计上是 3 的自然结果：任务名一旦升格成
独立的树节点，"下一行"就是"独立的一行"，不需要额外的多行 label 技巧；
转圈图标也就有了明确的落点（挂在任务名节点自己身上）。

## 2. 澄清阶段已确认的决策

以下选项均已向用户征询并确认，不再是开放问题：

| 问题 | 决策 |
|---|---|
| 一级分组键 | 按 `cwd` **精确**分组；cwd 不同的条目（哪怕只差一层）各自独立成组，哪怕组内只有一个条目也单独成组 |
| 拖拽排序范围 | 只允许**同一文件夹（同 cwd）内**重新排序；跨文件夹拖拽整体是 no-op |
| 三级节点默认展开/折叠 | 默认展开 |
| 转圈/绿点图标位置 | 只放在三级（任务名）行前面；二级（终端名）回归普通的存活/死亡图标，不再体现运行状态 |

## 3. 数据模型：`TreeNode` 类型扩展

`src/tree.ts` 现状（v0.1.3）：

```ts
export type TreeNode = EntryTreeItem | EmptyTreeItem;
```

`getChildren` 完全扁平：根返回全部 `EntryTreeItem`，任何非根元素返回 `[]`。

新增两个节点类型：

```ts
export type TreeNode = FolderTreeItem | EntryTreeItem | TaskTreeItem | EmptyTreeItem;
```

- **`FolderTreeItem`**（一级）：`id = \`folder:${cwd}\`` （必须稳定，否则每次
  `refresh()` 后 VS Code 会丢失用户手动折叠/展开的状态）；
  `collapsibleState = Expanded`；`label = cwd`（不再复用 `shortLabels()` 的
  「取最短唯一后缀」逻辑——那是给扁平列表消歧用的，现在文件夹本身就是唯一
  分组键，直接显示完整 cwd，过长由 VS Code 原生省略号处理，hover 显示全文）；
  `contextValue = 'folder'`（供 `package.json` 的 `view/item/context` 用
  `when` 排除文件夹节点，见 §6）。
- **`EntryTreeItem`**（二级）：`label = entry.name`（不再带 `highlights`/徽章）；
  `collapsibleState = taskName.length > 0 ? Expanded : None`；
  `description = alive ? undefined : '（无会话）'`（原来承载的 `shortPath`
  职责已由父级 `FolderTreeItem` 的标题取代，不再重复显示路径）；
  `iconPath` 回归两态：存活 `ThemeIcon('circle-filled', profileColor(entry))`，
  死亡 `ThemeIcon('circle-outline', profileColor(entry))`——**不再读
  `activity.state`**。
- **`TaskTreeItem`**（三级，only when `taskName.length > 0`）：
  `id = \`task:${entry.id}\`；`label = taskName`（纯字符串，无 highlights）；
  `collapsibleState = None`；`iconPath` 按 `activity.state` 三态：
  - `running` → `ThemeIcon('loading~spin', profileColor(entry))`
  - `done-unseen` → `ThemeIcon('circle-filled', new ThemeColor('charts.green'))`
  - `idle`（有任务名但当前空闲——常见状态，见下方说明）→
    `ThemeIcon('circle-filled', profileColor(entry))`
  - `command`（点击=`tmuxTerminals.open`，与父级 `EntryTreeItem` 一致，并且
    仍要调用 `tracker.markSeen(entry.id)`，逻辑从 `EntryTreeItem` 的点击
    处理迁移过来）

  > 关于「idle 状态为何还可能有非空 taskName」：`core/activity.ts` 的
  > `nextActivity` 里，`taskName` 每次采样都被覆盖、与 `state` 无关联——
  > 一个空闲但之前被 claude 起过任务名的会话，`state: 'idle'` 与
  > `taskName: '实现功能 X'` 会同时成立。这不是 bug，是刻意设计（v0.1.3
  > 已如此），只是现在需要在三级节点的图标分支里显式处理，不能遗漏。

- **`EmptyTreeItem`**：无变化，仍是根节点为空时的占位。

## 4. `getChildren` 改写

```ts
async getChildren(element?: TreeNode): Promise<TreeNode[]> {
  if (element === undefined) {
    this.entries = await this.store.load();
    if (this.entries.length === 0) return [new EmptyTreeItem()];
    return groupByCwd(this.entries).map(([cwd, group]) => new FolderTreeItem(cwd, group));
  }
  if (element instanceof FolderTreeItem) {
    return element.entries.map((e) => new EntryTreeItem(
      e,
      this.alive.has(sessionNameFor(e.id)),
      this.activity?.activityFor(e.id),
    ));
  }
  if (element instanceof EntryTreeItem) {
    const activity = this.activity?.activityFor(element.entry.id);
    const taskName = activity?.taskName ?? '';
    return taskName.length > 0 ? [new TaskTreeItem(element.entry, activity)] : [];
  }
  return [];
}
```

`groupByCwd`（纯函数，放 `core/`，与既有 `shortLabels` 同一模块或新建
`core/grouping.ts`）：按 `cwd` 分桶，桶内保持 `entries` 数组里的原有相对顺序
（即已经按 `order` 排好序的顺序），桶的顺序 = 各桶第一个条目在原数组中的
出现顺序（不额外排序文件夹本身，避免用户已熟悉的大致位置被打乱）。

## 5. 拖拽：仅同文件夹内重排

`handleDrag`（改动点：约束"只拖同 cwd 的条目"）：

```ts
async handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer): Promise<void> {
  const items = source.filter((n): n is EntryTreeItem => n instanceof EntryTreeItem);
  if (items.length === 0) return;
  const cwd = items[0].entry.cwd;
  if (!items.every((n) => n.entry.cwd === cwd)) return; // 跨文件夹多选：整体不产生 drag data
  data.set(this.dragMimeTypes[0], new vscode.DataTransferItem(items.map((n) => n.entry.id)));
}
```

`handleDrop`：目标必须解析出一个 cwd（`EntryTreeItem` 用 `entry.cwd`；
`FolderTreeItem` 用它自己的 `cwd`；其余类型 = 无目标 cwd），且必须等于拖拽源
的 cwd，否则整体 no-op：

```ts
async handleDrop(target: TreeNode | undefined, sources: vscode.DataTransfer): Promise<void> {
  const item = sources.get(this.dragMimeTypes[0]);
  if (!item) return;
  const draggedIds = item.value as string[];
  if (!Array.isArray(draggedIds) || draggedIds.length === 0) return;

  const all = await this.store.load();
  const draggedCwd = all.find((e) => e.id === draggedIds[0])?.cwd;
  if (draggedCwd === undefined) return;

  const targetCwd =
    target instanceof EntryTreeItem ? target.entry.cwd :
    target instanceof FolderTreeItem ? target.cwd :
    undefined;
  // undefined targetCwd（比如落在空白处）按"落在自己文件夹末尾"处理；
  // 明确落在别的文件夹（entry 或 folder 节点）上则整体 no-op。
  if (targetCwd !== undefined && targetCwd !== draggedCwd) return;

  const targetId = target instanceof EntryTreeItem ? target.entry.id : undefined;
  if (targetId !== undefined && draggedIds.includes(targetId)) return;

  const allIds = all.map((e) => e.id);
  const groupIds = all.filter((e) => e.cwd === draggedCwd).map((e) => e.id);
  const newIds = reorderWithinGroup(allIds, groupIds, draggedIds, targetId);

  await this.store.reorder(newIds);
  this.emitter.fire();
}
```

`reorderWithinGroup`（**新增纯函数**，`core/reorder.ts`，需要单测）：

```ts
/**
 * allIds：当前全局顺序（= store.reorder 需要的完整数组）。
 * groupIds：属于目标文件夹的那些 id（allIds 的子序列，顺序取自 allIds）。
 * draggedIds：本次拖拽的 id（groupIds 的子集）。
 * targetId：落点 id（groupIds 内某个未被拖拽的 id），undefined = 落到组尾。
 *
 * 语义：只重排 groupIds 内部的相对顺序，把结果按原位置"回填"进 allIds——
 * 不属于该组的 id 的相对顺序原样不动。
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
```

这个函数与现有 `handleDrop` 的插入语义（"落到目标行=插到它前面，落到空白=
追加到尾部"）保持一致，只是把作用范围从"全局"收窄到"组内"。

## 6. 命令面板 / 右键菜单的 `when` 条件

`package.json` 的 `view/item/context` 目前所有条目都是
`view == tmuxTerminals.list`（部分加 `viewItem == aliveSession`）。三级树
引入后，右键在 `FolderTreeItem` 或 `TaskTreeItem` 上不应该出现"打开终端/
编辑/删除"这些只对 `EntryTreeItem` 有意义的命令。

处理方式：`FolderTreeItem.contextValue = 'folder'`，`TaskTreeItem.contextValue
= 'task'`，两者都不等于 `'aliveSession'` / `'deadSession'`。命令处理函数里
已有的 `item()` 辅助（`arg instanceof EntryTreeItem` 的守卫）不需要改——
非 `EntryTreeItem` 直接被判定为"无效参数"而拒绝执行，本来就是安全的；唯一
要补的是 `package.json` 里把现在裸露的 `view == tmuxTerminals.list` 收紧为
`... && (viewItem == aliveSession || viewItem == deadSession)`，避免右键菜单
在文件夹/任务名节点上出现一排点了没反应的命令项。

点击 `TaskTreeItem`（`command: tmuxTerminals.open`）与点击 `EntryTreeItem`
效果一致（都是打开/接回该条目的终端），且都要 `tracker.markSeen(entry.id)`。
因此 `TaskTreeItem` 必须像 `EntryTreeItem` 一样暴露一个 `entry: TerminalEntry`
字段；`extension.ts` 里 `tmuxTerminals.open` 处理函数现有的
`arg instanceof EntryTreeItem` 类型守卫要放宽成
`arg instanceof EntryTreeItem || arg instanceof TaskTreeItem`（取
`arg.entry`），否则点击任务名那一行会因为守卫拒绝而完全没反应。

## 7. `ActivityTracker` 精简

`blinkOn(entryId)` 与内部的 `phaseOn` 字段整体删除——不再有任何 UI 需要
"闪烁相位"这个概念。`poll()` 里 `this.phaseOn = !this.phaseOn` 那行一并删除。
`activityFor` / `markSeen` / `poll` 的其余逻辑不变（三态状态机本身
`core/activity.ts` 完全不需要改，"闪烁"从来是渲染层概念，不是状态机概念）。

`EntryTreeProvider` 构造函数里给 `activity` 参数用的结构化接口也要去掉
`blinkOn`：

```ts
private readonly activity?: {
  activityFor(entryId: string): EntryActivity | undefined;
},
```

`tree.ts` 里所有 `this.activity?.blinkOn(...)` 调用点一并删除。

## 8. 不变量清单

1. **没有任务名的条目绝不能生出三级节点**——`getChildren` 对 `EntryTreeItem`
   的分支必须先判 `taskName.length > 0` 再决定要不要返回 `TaskTreeItem`；
   `EntryTreeItem` 自己的 `collapsibleState` 必须和这个判断保持一致
   （否则会出现"看起来能展开、展开后却是空的"这种 UI 缺陷）。
2. **跨文件夹拖拽必须是纯 no-op**，不能产生任何中间态（比如"部分移动"）——
   `handleDrop` 一旦发现 `targetCwd !== draggedCwd` 就要在做任何
   `store.reorder` 调用之前直接 `return`。
3. **`reorderWithinGroup` 绝不能改变组外 id 的相对顺序**——这是它区别于
   "把整个数组按新顺序重写"的核心约束，必须有单测直接断言"组外 id 序列在
   重排前后逐一相等"。
4. **`FolderTreeItem`/`TaskTreeItem` 的 `id` 必须是确定性的纯函数**
   （`folder:${cwd}` / `task:${entry.id}`），不能用数组下标之类会因增删条目
   而漂移的东西——否则用户展开状态会在无关操作后被 VS Code 错误保留/丢失。
5. `markSeen` 的触发点从"点击 `EntryTreeItem`"迁移到"点击 `TaskTreeItem`"后，
   点击 `EntryTreeItem` 本身（没有任务名子节点、或用户没展开就直接点了
   二级行）**仍然要能打开终端**，只是不需要 `markSeen`（没有 done-unseen
   状态可清，因为二级图标已经不带这个状态了）。

## 9. 测试计划

- `test/core/reorder.test.ts`（新增）：覆盖组内插入到中间/头/尾、拖拽多个
  id、目标是被拖拽 id 自身（no-op）、组外 id 顺序不变的直接断言。
- `test/core/activity.test.ts`：不需要改（状态机本身无变化）。
- `test/activityTracker.test.ts`：删除 `blinkOn` 相关的用例。
- `test/e2e-harness.js`：新增/修改场景覆盖三级 `getChildren`（文件夹→条目→
  任务名逐层展开）、跨文件夹拖拽 no-op、同文件夹内拖拽确实改变
  `store.reorder` 收到的数组。

## 10. 已知取舍

| 项 | 取舍 |
|---|---|
| cwd 精确分组、单条目也独立成组 | 用户明确选择的方案；代价是 cwd 高度分散时会出现很多"只有一个条目"的文件夹节点，比之前的纯扁平列表多一层点击/视觉层级 |
| 拖拽限制在同文件夹内 | 换掉之前"全局拖拽任意重排"的自由度；跨文件夹移动条目现在只能通过「编辑」改 cwd 实现，不再支持拖拽直接改归属 |
| 文件夹标题用完整 cwd，不做消歧裁剪 | 放弃了 `shortLabels()` 的裁剪逻辑，长路径依赖 VS Code 原生省略号 + hover；换来的是不用再维护一套"跨条目消歧"的裁剪算法 |

## 11. 实施后修订

（实施完成后回填，记录与设计不符之处）
