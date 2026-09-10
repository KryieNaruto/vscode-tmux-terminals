/** 路径与条目名校验的纯函数。不依赖 vscode。 */

/**
 * 展开开头的 `~`。
 *
 * 必须自己做：`vscode.window.createTerminal({ cwd })` 不认 `~/xxx`。
 * 只处理 `~` 和 `~/`，不从 `~user/` 里解析别人的 home —— tmux/系统
 * 会自己报错，扩展不该猜。
 */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p;
}

/**
 * 家目录下的路径显示成 `~/…`，其余原样。
 *
 * 存在的理由：候选有两个来源（已用条目、扫描发现），同一个目录会以
 * `/home/u/workspace/Mine` 和 `~/workspace/Mine` 两种写法各来一次。
 * 两者必须在**去重之前**归一成同一种写法，否则列表里会重复出现。
 */
export function displayPath(p: string, home: string): string {
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

/** 去掉最后一段得到父目录。已经在根上则返回根自身（不会无限上溯）。 */
export function parentOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/**
 * 候选目录的扫描根 = 每个已用目录自身 + 它的父目录，最后兜底家目录。
 *
 * **不要在这里硬编码 `~/workspace`。** 那是一个关于「工作区在哪」的
 * 猜测，实测就会错：本机 home 是 `/home/qiansenwei`，而工作树在
 * `/ssd/qiansenwei/workspace`，两者毫无关系。硬编码家目录只会扫出
 * 一堆用户从不使用的目录（实测 26 条候选里 24 条来自 `~/`），而用户
 * 真正在用的树永远不出现。
 *
 * 以「已经用过的目录」为依据则既短又准：扫自身能列出它的子目录，
 * 扫父目录能列出它的同级目录。两者都随用户的实际用法自动扩张。
 *
 * 顺序有意义：已用目录在前、家目录在后，这样 rankCandidates 排出来
 * 的列表把与工作相关的目录排在前面。
 */
export function scanRoots(used: string[], home: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    if (p.length > 0 && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const u of used) {
    const abs = expandHome(u.trim(), home);
    // 相对路径定不了父目录，跳过；否则 parentOf 会算出无意义的根。
    if (!abs.startsWith('/')) continue;
    add(abs);
    const par = parentOf(abs);
    if (par !== abs) add(par);
  }
  add(home);
  return out;
}

/** 读某目录的直接子目录名。注入实现以便脱离文件系统测试。 */
export type ReadSubdirs = (dir: string) => Promise<string[]>;

/**
 * 按扫描根列出候选目录。去重/排序/截断交给 rankCandidates。
 *
 * 某个根不存在或不可读时**静默跳过** —— 目录不存在不是错误，
 * 不该弹窗打扰用户。
 */
export async function discoverCandidates(
  roots: string[],
  home: string,
  readSubdirs: ReadSubdirs,
): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    const base = root.replace(/\/+$/, '');
    try {
      for (const name of await readSubdirs(root)) {
        if (name.startsWith('.')) continue;
        out.push(displayPath(`${base}/${name}`, home));
      }
    } catch {
      // 不存在或不可读 → 跳过这个根，继续下一个
    }
  }
  return out;
}

/**
 * 校验条目显示名。返回错误消息，或 null 表示通过。
 *
 * **只校验显示用途**：名字不再用作 tmux 会话名（会话名由条目 id 派生，
 * 见 core/tmux.ts 的 sessionNameFor）。所以 `:`、`.`、纯数字都放行——
 * 用户想叫 "build.android" 或 "2024" 都合理。
 *
 * 只拦两类：空白名（没有意义）和含换行/回车的名字（会破坏 TreeView
 * 的单行展示）。重名也拦，因为会话名既然由 id 派生，重名就不再是
 * 技术冲突而纯粹是用户困惑，仍应避免。
 */
export function validateName(name: string, existingNames: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '名称不能为空';
  if (/[\r\n]/.test(name)) return '名称不能包含换行';
  if (existingNames.includes(trimmed)) return `名称「${trimmed}」已存在`;
  return null;
}

/**
 * 把候选项去重、排序、截断。
 *
 * 排序规则：条目里**已用过的目录最优先**（对高频目录最有用），其余按给定顺序。
 * 截断数量必须回报 —— 静默丢弃会让用户以为没有那个目录。
 */
export function rankCandidates(
  used: string[],
  discovered: string[],
  limit = 50,
): { items: string[]; truncated: number } {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...used, ...discovered]) {
    const t = p.trim();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return { items: out.slice(0, limit), truncated: Math.max(0, out.length - limit) };
}
