import { SessionSlot } from './types';

/**
 * 会话槽的排序与编号。
 *
 * 纯函数、零 vscode、零 IO（spec §11.14）。store 归一化、tree 渲染、manager
 * 拼启动命令都要按同一套规则看槽 —— 规则只留这一份。
 */

/**
 * 按 order 升序**稳定**排序，并把负数 order 钳到 0。
 *
 * **为什么钳负数**：与 `EntryStore.load()` 对**条目** order 的处理同源
 * （src/core/store.ts 里那条注释：一个 -1 会永远排最前，而写入又会重编号，
 * 状态自相矛盾）。负数只可能来自手改清单文件，会话 order 走同一条路。
 *
 * **为什么稳定性要显式写**（用原下标做次级键，而不是指望 sort 恰好稳定）：
 * 槽的 order 真的会相等（手改文件；将来允许拖动排序更是常态）。相等时顺序
 * 变成未定义的表现是「同一份清单两次读出来顺序不同」，树在两次刷新之间跳行,
 * 且没有任何报错 —— 定位成本极高，防它的成本只有这一个 i。
 *
 * 返回的槽一律是新对象：调用方（`store.updateSession` 之类）会把它当不可变
 * 数据拼进新数组，共享同一个对象会让「改一个槽」顺带改掉上一次 load 的产物。
 */
export function sortSessions(slots: readonly SessionSlot[]): SessionSlot[] {
  return slots
    .map((s, i) => ({ s: { ...s, order: Math.max(0, s.order) }, i }))
    .sort((a, b) => (a.s.order - b.s.order) || (a.i - b.i))
    .map((x) => x.s);
}

/**
 * 下一个可用 order（max + 1；空数组 → 0）。
 *
 * **必须在 store 的锁内调用**：在锁外算，两次并发新增会算出同一个 order，
 * 排序随即变得不确定 —— 与 `append` 的 order 是同一条理由，用同一种办法
 * （把复合操作收进锁内）解决。
 *
 * 取 max + 1 而不是 `slots.length`：删过中间槽之后 length 会与现存槽撞号，
 * 两个槽 order 相同 → 顺序变成未定义。负数一并按 0 看待（与 sortSessions
 * 同一条规则），否则刚钳成 0 的槽会让新槽排到负数去。
 */
export function nextSessionOrder(slots: readonly SessionSlot[]): number {
  return slots.reduce((m, s) => Math.max(m, Math.max(0, s.order)), -1) + 1;
}
