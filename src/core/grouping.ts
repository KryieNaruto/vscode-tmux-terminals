import { TerminalEntry } from './types';

/**
 * 按 cwd 精确分组，用于三级树的一级「文件夹」节点。
 *
 * 分组顺序 = 各组第一个条目在输入数组中的出现顺序（不额外排序）；
 * 组内顺序原样保留输入顺序（调用方已按 order 排好序，这里不重排）。
 */
export function groupByCwd(
  entries: TerminalEntry[],
): Array<[string, TerminalEntry[]]> {
  const order: string[] = [];
  const groups = new Map<string, TerminalEntry[]>();
  for (const e of entries) {
    let g = groups.get(e.cwd);
    if (g === undefined) {
      g = [];
      groups.set(e.cwd, g);
      order.push(e.cwd);
    }
    g.push(e);
  }
  return order.map((cwd) => [cwd, groups.get(cwd)!]);
}
