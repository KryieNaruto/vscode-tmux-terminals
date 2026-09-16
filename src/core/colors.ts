/**
 * 二级行首那条竖线的颜色：预设色、输入归一化、SVG 文本。
 *
 * 纯函数、零 vscode、零 IO（spec §11.14）。真正落盘与缓存路径在
 * `src/colorIcons.ts` —— 那个文件用 vscode.Uri 与 fs，必须挡在 core 之外，
 * 否则本模块就没法脱离编辑器单测了。
 */

/**
 * 预设色，8 个。
 *
 * 每个都是**已归一化**的小写 `#rrggbb`：写成大写或三位简写的话，同一个颜色
 * 在清单里会出现两种写法，`<globalStorage>/colors/<hex>.svg` 也会落成两个
 * 文件（颜色一样、图标却是两张）。`test/core/colors.test.ts` 用
 * `normalizeHexColor` 把这条钉住了。
 */
export const PRESET_COLORS: readonly string[] = [
  '#e5484d', // 红
  '#f76b15', // 橙
  '#ffb224', // 黄
  '#46a758', // 绿
  '#12a594', // 青
  '#0090ff', // 蓝
  '#8e4ec6', // 紫
  '#e93d82', // 品红
];

const HEX3 = /^[0-9a-f]{3}$/;
const HEX6 = /^[0-9a-f]{6}$/;

/**
 * 归一化用户输入的颜色。
 *
 * 接受：`#rgb` / `#rrggbb` / 不带 `#` 的同样两种 / 大小写混写 / 首尾空白。
 * `#abc` → `#aabbcc`（三位简写逐位展开）。输出一律是**小写** `#rrggbb`。
 *
 * 其余一律 undefined：**绝不**把非法值写进清单，也绝不猜一个近似色 ——
 * 用户输入 `#gggggg` 时把它悄悄落成某个「差不多的颜色」，比直接说「不合法」
 * 更坏：他会以为自己挑的那个颜色生效了。
 */
export function normalizeHexColor(input: string): string | undefined {
  const s = input.trim().replace(/^#/, '').toLowerCase();
  if (HEX6.test(s)) return `#${s}`;
  if (HEX3.test(s)) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  return undefined;
}

/**
 * 竖线图标（16×16）的 SVG 文本。
 *
 * **必须写死显式 fill** —— 颜色就是它的全部意义。**绝不用
 * `fill="currentColor"`**：仓库里已有一次实测教训（记在 manifest.test.ts 里），
 * VS Code 把图标当 CSS mask 渲染，currentColor 在那里解析不出颜色，结果是
 * 「图标占了位置但整个透明」，且不报任何错。
 *
 * 不用 `ThemeIcon` 的同类理由：它只能取**主题色**，表达不了任意 hex —— 而
 * 这条竖线的语义恰恰是「用户挑的那个颜色」，用主题色会撒谎。
 *
 * 入参**必须是 `normalizeHexColor` 的产物**：这里刻意不校验也不做转义。
 * 唯一的调用方 `ColorIconCache.iconFor` 先归一化、非法值回落中性竖线，所以
 * 手改进清单的垃圾值到不了这里。绕开它直接调用，等于把清单文件的内容原样
 * 拼进 SVG 属性。
 */
export function colorBarSvg(color: string): string {
  // x=7 / width=2：细、居中、上下各留 2px —— 与行高对齐后看起来是一条
  // 「小竖线」而不是一个色块。
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
    + `<rect x="7" y="2" width="2" height="12" rx="1" fill="${color}"/>`
    + '</svg>';
}
