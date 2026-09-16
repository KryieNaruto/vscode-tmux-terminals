import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { colorBarSvg, normalizeHexColor } from './core/colors';

/**
 * 二级行首那条竖线的图标解析与落盘。
 *
 * **为什么这个文件不在 `src/core/`**：它要用 `vscode.Uri` 与 `fs`，而
 * `core/*.ts` 必须能脱离编辑器 mocha 单测、且零 IO（spec §11.14）。纯逻辑
 * （调色板、归一化、SVG 文本）在 `core/colors.ts`，IO 只留在这一层。
 *
 * **渲染路径零 IO（spec §11.12）**：`iconFor` 只拼路径、**不同步读盘**。
 * `getChildren` 是同步语义（TreeDataProvider 期待立刻拿到 TreeItem），在这里
 * 同步读盘会让整棵树的渲染卡在磁盘上。代价是「文件还没落盘时图标短暂为空」，
 * 由调用方在 `activate()` 与 `setColorInteractive` 之后 `await ensure(...)`
 * 补上 —— 那是唯一两处「清单里出现了新颜色」的入口。
 */
export class ColorIconCache {
  /**
   * @param storageDir  自绘 SVG 的落盘目录（`<globalStorage>/colors`）。
   *   **绝不能写扩展安装目录**：vsix 解出来的目录可能是只读的，写入会
   *   抛 EROFS/EACCES，而这条路径在「用户设了个颜色」时才走到 —— 报错时机
   *   离原因很远。
   * @param extensionUri  扩展根，用于拼随包发布的两个中性竖线。
   */
  constructor(
    private readonly storageDir: string,
    private readonly extensionUri: vscode.Uri,
  ) {}

  /**
   * 未设颜色时的中性竖线：随扩展打包的两个 SVG，主题自适应。
   *
   * **不用 `ThemeIcon`**：它的颜色只能是**主题色**，而这条竖线的语义就是
   * 「用户挑的那个颜色」—— 用主题色会撒谎（spec §6.2）。中性态则相反：它
   * 必须跟着主题走，浅色主题下用深灰、深色主题下用浅灰，否则会糊在背景里。
   */
  neutral(): { light: vscode.Uri; dark: vscode.Uri } {
    return {
      light: vscode.Uri.joinPath(this.extensionUri, 'resources', 'colors', 'bar-light.svg'),
      dark: vscode.Uri.joinPath(this.extensionUri, 'resources', 'colors', 'bar-dark.svg'),
    };
  }

  /**
   * 同步解析出可用的 `iconPath`。
   *
   * **非法值与未设一并回落中性**：`normalizeHexColor` 只在**写入路径**
   * （`setColorInteractive`）把关，手改清单文件写进的 `#zzz` 会一路走到这里。
   * 把它拼进路径只会得到一个永远不存在的文件名 —— 表现为「这一行的竖线凭空
   * 消失」，且不报错。回落中性竖线是安全的：颜色信息没了，但至少这一行还有
   * 图标、用户看得出「这里本该有个颜色」。
   */
  iconFor(color?: string): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
    const hex = color === undefined ? undefined : normalizeHexColor(color);
    if (hex === undefined) return this.neutral();
    return vscode.Uri.file(path.join(this.storageDir, ColorIconCache.fileNameFor(hex)));
  }

  /**
   * 把一批颜色对应的 SVG 落到 storageDir（**幂等**，已存在则跳过）。
   *
   * 幂等不只是为了省一次写：这里会在每次 `activate()` 都对整份清单跑一遍，
   * 而 `globalStorage` 在卸载重装扩展时会被清掉，所以「跳过已存在」与
   * 「按需重建」两种行为都必须同时成立 —— 无脑覆盖会把 mtime 刷成每次启动的
   * 时间，无脑跳过则会在目录被清掉之后永远画不出图标。
   *
   * **单个颜色写失败不抛出**：两个中性 SVG 仍然在包里，最坏的结果是那一行
   * 回落到中性竖线（与颜色非法同侧），而不是整个 activate 失败、侧边栏空白。
   */
  async ensure(colors: readonly string[]): Promise<void> {
    const hexes = [
      ...new Set(
        colors
          .map((c) => normalizeHexColor(c))
          .filter((h): h is string => h !== undefined),
      ),
    ];
    if (hexes.length === 0) return;

    try {
      await fs.promises.mkdir(this.storageDir, { recursive: true });
    } catch {
      return; // 目录建不出来（只读挂载等）：整批放弃，图标回落中性。
    }

    for (const hex of hexes) {
      const file = path.join(this.storageDir, ColorIconCache.fileNameFor(hex));
      try {
        await fs.promises.access(file, fs.constants.F_OK);
        continue; // 已存在：内容只由 color 决定，不必重写。
      } catch {
        // 不存在 —— 继续往下写。
      }
      try {
        await fs.promises.writeFile(file, colorBarSvg(hex), 'utf8');
      } catch {
        // 单个文件写失败：跳过它，其余照写（见上）。
      }
    }
  }

  /**
   * 文件名：去掉 `#` 的 hex + `.svg`。
   *
   * 归一化保证 hex 是小写 `#rrggbb`，所以同一个颜色永远只有一个文件名。
   * 留着 `#` 会让它变成 URL 的 fragment（`.../colors/#aabbcc.svg`）——
   * 路径在下游被截断，图标找不到。
   */
  private static fileNameFor(hex: string): string {
    return `${hex.slice(1)}.svg`;
  }
}
