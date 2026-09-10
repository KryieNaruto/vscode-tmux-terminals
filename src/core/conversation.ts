/**
 * 「条目 ↔ claude 对话」的纯逻辑：候选枚举的解析与筛选、显示格式化。
 *
 * 本文件刻意不依赖 vscode，也不碰文件系统（IO 在 src/conversationFiles.ts），
 * 以便脱离编辑器直接单测。
 *
 * 背景（2026-09-10，实测结论，勿改）：
 * - `claude --resume <uuid>` **是按 cwd 作用域**的：从别的 cwd 运行会报
 *   `No conversation found with session ID`。所以恢复必须在条目自己的 cwd
 *   里 launch —— 扩展本来就是用 `-c cwd` 建会话，天然满足。
 * - 会话文件里记录了 `"cwd":"<绝对路径>"` 字段。**枚举候选一律按这个字段
 *   筛，不要去猜 project 目录名的转义规则**（实测 `_` 和 `.` 也会被换成
 *   `-`，规则不可靠）。
 * - claude 进程不长期持有 .jsonl 的 fd，无法从 /proc 反查运行中会话的 id，
 *   因此绑定关系只能由扩展自己记（见 types.ts 的 conversationId）。
 */

/** 一条可接回的对话（由 ~/.claude/projects 下的 .jsonl 枚举而来）。 */
export interface ConversationCandidate {
  /** 对话 id = 会话文件名（去掉 .jsonl），即 `--resume` 的参数 */
  id: string;
  /** 会话文件里记录的 cwd —— 权威的归属判据 */
  cwd: string;
  /** 文件 mtime（毫秒），用于倒序 */
  mtimeMs: number;
  /** 文件体积（字节），用于在列表里辨认 */
  bytes: number;
  /** 首条用户消息的摘要；取不到为空串 */
  summary: string;
}

/** 摘要最长字符数 —— QuickPick 一行装不下更多，也够认出「就是这个终端」。 */
const SUMMARY_MAX = 60;

/** 从 user 消息的 content 里取纯文本（可能是字符串，也可能是分块数组）。 */
function firstText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { type?: unknown; text?: unknown };
      // 只认 text 块：tool_result 是工具回执，不是用户敲进去的话
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
    }
  }
  return undefined;
}

/** 压平空白并截断，避免多行摘要在列表里错位。 */
function condense(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX)}…` : flat;
}

/**
 * 从一段 .jsonl 文本（通常只读了文件头部）里提取 cwd 与首条用户消息摘要。
 *
 * 容错是契约：末行多半被截断、某些行类型不熟悉 —— 一律跳过，绝不抛错。
 * 解析不出来就返回空对象，**绝不编造**。
 */
export function parseConversationHead(text: string): { cwd?: string; summary?: string } {
  let cwd: string | undefined;
  let summary: string | undefined;

  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      continue; // 被截断的末行 / 不认识的行
    }
    if (typeof o !== 'object' || o === null) continue;
    const rec = o as Record<string, unknown>;

    if (cwd === undefined && typeof rec.cwd === 'string' && rec.cwd.length > 0) {
      cwd = rec.cwd;
    }
    // 跳过子代理（isSidechain）的消息 —— 那不是用户敲的，认不出终端
    if (summary === undefined && rec.type === 'user' && rec.isSidechain !== true) {
      const msg = rec.message as { content?: unknown } | undefined;
      const t = msg === undefined ? undefined : firstText(msg.content);
      if (t !== undefined && t.trim().length > 0) summary = condense(t);
    }
    if (cwd !== undefined && summary !== undefined) break;
  }

  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };
}

/** 只忽略末尾斜杠，其余精确比较（`/a/b` 与 `/a/bc` 不是同一个目录）。 */
function normalize(p: string): string {
  if (p.length === 0) return p;
  const stripped = p.replace(/\/+$/, '');
  return stripped.length === 0 ? '/' : stripped;
}

/** 这条对话是否属于该 cwd —— 归属判据的唯一来源。 */
export function belongsToCwd(candidateCwd: string, cwd: string): boolean {
  if (candidateCwd.length === 0 || cwd.length === 0) return false;
  return normalize(candidateCwd) === normalize(cwd);
}

/**
 * 只保留属于该 cwd 的候选，按 mtime 倒序（最近用过的在前）。
 *
 * mtime 相同时按 id 排序：否则每次弹 QuickPick 的顺序都可能不同，
 * 用户手速快就会选错。
 */
export function candidatesForCwd(
  items: readonly ConversationCandidate[],
  cwd: string,
): ConversationCandidate[] {
  return items
    .filter((c) => belongsToCwd(c.cwd, cwd))
    .slice()
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 体积的可读格式。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** 本地时间戳 `YYYY-MM-DD HH:mm`。 */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * QuickPick 的一行：`<时间> · <首条用户消息摘要> · <体积>`。
 * 三样都要有，用户才能认出「就是这个终端」。
 */
export function formatCandidate(c: ConversationCandidate): string {
  return `${localStamp(c.mtimeMs)} · ${c.summary.length > 0 ? c.summary : '（无摘要）'} · ${formatBytes(c.bytes)}`;
}
