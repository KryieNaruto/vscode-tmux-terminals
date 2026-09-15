/**
 * 进程表解析与「后代集合」推导的纯函数。
 *
 * 本文件刻意不依赖 vscode、也不碰文件系统/进程（`ps` 的调用在
 * src/liveSessions.ts），以便脱离编辑器直接单测。
 *
 * 用途：tmux 的 `#{pane_pid}` 是**外层 shell** 的 pid，claude 是它的后代
 * （实测：某个 pane 的 pane_pid=287661 是 `-bash`，claude 3777899 的 ppid
 * 就是它）。但**不能只看直接子进程** —— 一个 pane 下 claude 后代可能不止
 * 一个（实测抓到过孤儿进程），必须沿后代下探。
 */

/**
 * `ps -eo pid=,ppid=` 的一行解析结果。
 */
export interface ProcNode {
  pid: number;
  ppid: number;
}

/**
 * 解析进程表文本。无法解析的行一律跳过，绝不抛错。
 *
 * `ps -eo pid=,ppid=` 的输出形如 `  287661    1234`（等号让 ps 省掉表头）。
 */
export function parseProcTable(text: string): ProcNode[] {
  const out: ProcNode[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (pid <= 0) continue; // 0 = 内核调度器，不是真实进程
    out.push({ pid, ppid });
  }
  return out;
}

/**
 * rootPid 在 table 里的**全部后代** pid（含各层，不含 rootPid 自身）。
 *
 * 表里查不到 rootPid 时返回 []。自身成环、pid 重复等畸形输入必须安全终止 ——
 * `seen` 集同时承担「防环」与「去重」两个职责。
 */
export function descendantsOf(table: readonly ProcNode[], rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const node of table) {
    const list = children.get(node.ppid);
    if (list === undefined) children.set(node.ppid, [node.pid]);
    else list.push(node.pid);
  }

  const out: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue; // 成环 / pid 重复 → 安全终止
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}
