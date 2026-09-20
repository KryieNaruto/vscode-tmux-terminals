import { SessionSlot, TerminalEntry } from './types';

/**
 * VS Code 终端面板的**显示名**规则。
 *
 * 纯函数、零 vscode、零 IO —— 与 core/sessions.ts、core/reorder.ts 同一族：
 * 规则只留一份，manager 的每一处建面板 / 找面板都从这里取名字。
 */

/**
 * 追加在面板名末尾的槽 id 前缀长度。
 *
 * 槽 id 是 `newId()` 产出的 12 位十六进制串（crypto.randomBytes(6)），
 * 取前 4 位即 16^4 = 65536 种取值 —— 同一个条目下最多挂几个槽，
 * 碰撞概率可以忽略；而 4 个字符短到面板标签上不会盖住条目名本身。
 * 取更长（比如 8 位）只是把噪声放大一倍，换不来任何实际分辨力。
 */
const SLOT_TAG_CHARS = 4;

/**
 * 面板名。**名字是这个面板跨扩展宿主重建后唯一的身份依据。**
 *
 * VS Code 的 `Terminal` 挂不了自定义数据（没有给扩展用的 data 字段），
 * 宿主重载后 `window.terminals` 里只剩 `name` 可查，而内存 Map 已经清空
 * —— `candidatePanel` 的按名兜底、`decideOpen` 的 present 判据全靠它。
 * 名字一撞，两个槽就共用一个身份。
 *
 * **撞名的后果不止「用错面板」这么轻**：`decideOpen`（core/restore.ts）
 * 在「会话存活 + 有客户端附着 + present」时直接返回 `'show'`，`openSession`
 * 随即把**找到的那个别人的面板** show 出来并缓存映射就 return 了 —— 真正
 * 该建的那个面板**永远不会被建**。多会话条目下点第 2 个起的槽「点了没反应」，
 * 就是这个形态（v3 多会话引入的回归：v1/v2 一个条目只有一个会话，
 * entry.name 天然唯一，撞不上）。
 *
 * **单槽不加后缀**：单槽是绝大多数情形，`entry.name` 本来就唯一，加一截
 * 随机串纯粹是噪音 —— 用户还得从标签上认出这是哪个终端。
 *
 * **已知代价（用户已接受）**：给某条目**新增第 2 个槽**的那一瞬间，它
 * 原面板的名字（`entry.name`）与新期望名（`entry.name · xxxx`）对不上，
 * 于是那一次会多建一个面板（旧面板留在那里）。这是一次性的、且只发生在
 * 用户刚动手加槽之后，比「点了跳到别的会话」轻得多。
 */
export function panelNameFor(entry: TerminalEntry, slot: SessionSlot): string {
  // 单槽（含 0 槽）：原样返回 entry.name，一个字符都不加 —— 见上面
  // 「单槽不加后缀」。0 槽的条目点不到、也不会建面板，走这一支同样安全。
  if (entry.sessions.length <= 1) return entry.name;
  return `${entry.name} · ${slot.id.slice(0, SLOT_TAG_CHARS)}`;
}
