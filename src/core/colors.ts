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

/**
 * 色块图标（16×16）的 SVG 文本，给 QuickPick 的**每一项**用。
 *
 * 为什么不复用 `colorBarSvg`：这两个图形解决的是两个问题。竖线是「二级行首
 * 的窄条」，只有 2px 宽 —— 放在 QuickPick 行首时小得几乎看不出颜色；而选颜色
 * 这一步恰恰要让人**一眼比出几个颜色**，得是一个够大的填充方块。所以这里自己
 * 画一个 12×12 的圆角方块（x/y 各留 2px 当内边距），而不是把竖线拉宽。
 *
 * **必须写死显式 fill**，与 `colorBarSvg` 同一条实测教训：**绝不用
 * `fill="currentColor"`** —— VS Code 把图标当 CSS mask 渲染，currentColor 在
 * 那里解析不出颜色，结果是「图标占了位置但整个透明」，且不报任何错。
 *
 * **必须再描一圈边**：纯色块没有边界，在浅色/深色主题下都可能与背景糊在一起
 * —— 用户自定义一个接近白色或接近黑色的 hex 时尤其明显。描边保证「这一项有
 * 颜色」这件事在任何主题下都看得见。描边色用**不透明**的灰（`#808080`）：8 位
 * 带 alpha 的写法（如 `#80808080`）在图标里不保证被支持，别赌它。
 *
 * 入参**必须是 `normalizeHexColor` 的产物**：这里刻意不校验也不做转义，理由与
 * `colorBarSvg` 完全相同 —— 绕开它直接调用，等于把清单文件的内容原样拼进 SVG
 * 属性。
 */
export function colorSwatchSvg(color: string): string {
  // x/y=2 + width/height=12：四周各留 2px，方块不贴边；rx=3 是 16px 画布上
  // 「看得出圆角但仍是方块」的取法。
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">'
    + `<rect x="2" y="2" width="12" height="12" rx="3" fill="${color}" stroke="#808080" stroke-width="1"/>`
    + '</svg>';
}

/** 调色板里的一项：给 QuickPick 渲染用的**纯数据**，不含任何 vscode 类型。 */
export interface ColorChoice {
  /** 归一化后的小写 `#rrggbb`，同时也是 QuickPickItem 的 label。 */
  hex: string;
  /** 是不是「这个条目当前已选的颜色」。 */
  current: boolean;
}

/**
 * 预设色 + 「当前色」的调色板模型。
 *
 * 为什么要有这个纯函数：QuickPick 的项列表要同时表达「8 个预设」和「用户此刻
 * 用的是哪个」两件事，直接写在 UI 层就会牵进 vscode 类型、没法单测。这里只产出
 * **纯数据**，由 UI 层负责把它包装成 QuickPickItem（图标用 `colorSwatchSvg`）。
 *
 * 入参 `current` 先过 `normalizeHexColor`，**非法值不抛错**：清单文件可能被手改
 * 成垃圾值，那种情况下「当作没有当前色」照常列出 8 个预设即可 —— 选颜色这个动作
 * 不该因为一个坏值而整个打不开。
 *
 * 顺序规则：当前色**本身就在预设里**时保持 `PRESET_COLORS` 的原顺序（否则每次
 * 打开选单，列表顺序都会随当前色跳来跳去）；当前色**是自定义 hex** 时把它插到
 * 最前面再跟 8 个预设，这样「我现在的颜色」永远在列表第一行、一眼可见。
 */
export function colorChoices(current?: string): ColorChoice[] {
  const normalized = current === undefined ? undefined : normalizeHexColor(current);
  if (normalized === undefined) {
    return PRESET_COLORS.map((hex) => ({ hex, current: false }));
  }
  if (PRESET_COLORS.indexOf(normalized) !== -1) {
    return PRESET_COLORS.map((hex) => ({ hex, current: hex === normalized }));
  }
  return [
    { hex: normalized, current: true },
    ...PRESET_COLORS.map((hex) => ({ hex, current: false })),
  ];
}
