import * as fs from 'fs/promises';
import * as path from 'path';
import {
  ConversationCandidate,
  belongsToCwd,
  candidatesForCwd,
  parseConversationHead,
  parseConversationTail,
} from './core/conversation';

/**
 * 枚举 `~/.claude/projects/**` + `**\/*.jsonl` 下所有可接回的对话。
 *
 * 交由 core/conversation.ts 的纯函数做筛选与格式化；这里只负责读盘。
 *
 * **只读文件头部。** 实测单条会话可以到 7.8 MB，而我们需要的信息（cwd、
 * 首条用户消息）都在开头 ~20 KB 内。整读 293 个文件会白读几百 MB。
 * 超出上限就退化为「没有摘要」——候选仍然可用（时间 + 体积 + 目录足以辨认），
 * 绝不因为没有摘要就把这条候选丢掉。
 *
 * 目录名（`-ssd-qiansenwei-workspace` 之类）**只用来找文件，不用来判断归属** ——
 * 转义规则不可靠（`_`、`.` 也会变成 `-`），归属一律以文件里记录的 cwd 字段为准。
 */

/**
 * 头部读取上限。实测首条用户消息落在 ~20 KB 处（前面是体积较大的
 * attachment 行），64 KB 留了 3 倍余量。
 */
const HEAD_BYTES = 64 * 1024;

/**
 * 并发上限。
 *
 * **必须并发。** 实测用户机器的 ~/.claude/projects 有 31 个目录、292 个
 * 会话文件、合计 404 MB，且存储延迟很高：串行逐个 open+read 要 **8.7 s**，
 * 而并发后只要 **43 ms**（200 倍）。串行会让「全部恢复」在弹选择框之前
 * 先卡住十几秒 —— 那本身就是用户抱怨的那类体验。
 *
 * 但也不能无上限地开 fd：32 是吞吐与资源占用之间的折中。
 */
const CONCURRENCY = 32;

/** 限并发地 map。逐个 await 的写法在这里是不可接受的（见上）。 */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/** 读文件前 HEAD_BYTES 字节。文件更短时返回全部。 */
async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * 尾部读取窗口。**不是** HEAD_BYTES 的别名 —— 语义不同（这里读文件尾），
 * 数值相同只是巧合，两者各自独立演进。
 */
export const TAIL_BYTES = 64 * 1024;

/**
 * 读文件**尾部** bytes 字节（文件更短时返回全部）。
 *
 * 为什么必须能读尾部：`ai-title` 是**追加**记录不是头部字段，实测首次出现
 * 位置有 82/184 落在 64 KB 之后，而最后一次距 EOF 最远 53887 B ——
 * 只读头部会读不到 45% 的文件的标题。
 */
export async function readTail(file: string, bytes: number): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * 按 id + cwd 精确定位会话文件，返回它的**绝对路径**。
 *
 * 与 findConversations 有意重复一部分（都在 projects 下 readdir + 读头部）：
 * 那个函数的返回形状是 cwd 字符串数组、不含文件路径，而尾部读取必须先拿到
 * 路径才能 seek；想复用它就得改签名并牵动既有 3 个调用点，得不偿失。
 * 两者遵守同一套约定：目录名只用来找文件，归属一律以文件内记录的 cwd 为准。
 *
 * 找不到返回 undefined —— 绝不靠目录名转义规则反推。
 */
export async function findConversationFile(
  home: string,
  id: string,
  cwd: string,
): Promise<string | undefined> {
  const root = path.join(home, '.claude', 'projects');
  let dirs: string[];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    dirs = entries.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return undefined; // 没有 ~/.claude/projects —— 正常情况
  }

  const file = `${id}.jsonl`;
  const hits = await mapLimited(dirs, CONCURRENCY, async (dir) => {
    const full = path.join(root, dir, file);
    try {
      const head = await readHead(full, HEAD_BYTES); // 不存在会抛，跳过
      const parsed = parseConversationHead(head);
      return parsed.cwd !== undefined && belongsToCwd(parsed.cwd, cwd) ? full : undefined;
    } catch {
      return undefined;
    }
  });
  return hits.find((f): f is string => f !== undefined);
}

/**
 * 按 id 直查这条对话存在于哪些 cwd 下。
 *
 * 用途：判断该用 `--session-id`（把这条对话建出来）还是 `--resume`（接回它）。
 * **按文件名直查，不做全量枚举** —— 全量枚举要读 292 个文件的头部（实测
 * 冷启 3.5 s），而这里只需要 readdir 一层目录 + 读命中的那一个文件的头部。
 *
 * 返回**全部**命中的 cwd 而不是第一个：同一个 id 有可能出现在不同 cwd 的
 * project 目录下，调用方要判断「有没有落在本条目的 cwd 下的」——`--resume`
 * 是按 cwd 作用域的（见 core/conversation.ts 顶部注释）。
 */
export async function findConversations(home: string, id: string): Promise<string[]> {
  const root = path.join(home, '.claude', 'projects');
  let dirs: string[];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    dirs = entries.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }

  const file = `${id}.jsonl`;
  const found = await mapLimited(dirs, CONCURRENCY, async (dir) => {
    const full = path.join(root, dir, file);
    try {
      const head = await readHead(full, HEAD_BYTES);   // 不存在会抛，跳过
      return parseConversationHead(head).cwd;
    } catch {
      return undefined;
    }
  });

  return found.filter((cwd): cwd is string => cwd !== undefined);
}

/** 一条候选 + 它所在的文件路径。路径**不进导出接口**，只在本文件内用来读尾部。 */
interface ConversationRecord {
  candidate: ConversationCandidate;
  file: string;
}

/**
 * 枚举所有候选对话，并**在内部保留每条的文件路径**。
 *
 * 路径不塞进 ConversationCandidate：它是读盘细节，导出出去只会诱惑别的调用方
 * 自己再去 open 一遍。这里留着，是为了 listConversationsForCwd 能对幸存下来的
 * 那几条直接 readTail —— 否则就得用 findConversationFile 按 id 再扫一遍全部
 * project 目录（N 个候选 × 31 个目录的 readdir + 头部读），纯属重复劳动。
 *
 * 每一步都独立容错：某个 project 目录读不动、某个文件读不动，跳过即可，
 * 绝不让一条坏数据毁掉整次枚举（用户要靠这个列表找回自己的对话）。
 */
async function listConversationRecords(home: string): Promise<ConversationRecord[]> {
  const root = path.join(home, '.claude', 'projects');
  let dirs: string[];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    dirs = entries.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return []; // 没有 ~/.claude/projects —— 正常情况（从没用过 claude）
  }

  // 目录名只用来找文件，不用来判断归属（转义规则不可靠，见文件头注释）
  const listings = await mapLimited(dirs, CONCURRENCY, async (dir) => {
    const abs = path.join(root, dir);
    try {
      return (await fs.readdir(abs))
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(abs, f));
    } catch {
      return []; // 单个目录读不动，跳过
    }
  });
  const files = listings.flat();

  const records = await mapLimited(files, CONCURRENCY, async (full) => {
    try {
      const [stat, head] = await Promise.all([fs.stat(full), readHead(full, HEAD_BYTES)]);
      const parsed = parseConversationHead(head);
      // 读不出 cwd 就无法判断归属 —— 宁可漏掉一条，也绝不猜。
      if (parsed.cwd === undefined) return undefined;
      return {
        candidate: {
          id: path.basename(full).replace(/\.jsonl$/, ''),
          cwd: parsed.cwd,
          mtimeMs: stat.mtimeMs,
          bytes: stat.size,
          summary: parsed.summary ?? '',
        },
        file: full,
      };
    } catch {
      return undefined; // 单条读不动不影响其余
    }
  });

  return records.filter((r): r is ConversationRecord => r !== undefined);
}

/**
 * 读出所有候选对话（不含最后一问一答）。
 *
 * 需要「最后一问一答」的场景请用 listConversationsForCwd —— 那个才会按 cwd
 * 过滤后再读尾部；对全部 292 个文件读尾部是纯浪费。
 */
export async function listConversations(home: string): Promise<ConversationCandidate[]> {
  return (await listConversationRecords(home)).map((r) => r.candidate);
}

/**
 * 该 cwd 下的候选对话，并补上**最后一问一答**（QuickPick 的 detail / tooltip）。
 *
 * **先按 cwd 过滤、再读尾部**：全量是 292 个文件、404 MB（见文件头注释），
 * 而一个 cwd 下通常只有十几条。顺序反了就是给每条无关的对话白读一次盘。
 *
 * 并发读尾部，同样走 mapLimited —— 逐个 await 在这里退化回那个 8.7 s 的串行
 * 版本（见 CONCURRENCY 处注释）。
 *
 * 每条独立容错：尾部读不动 / 解析不出，就当作「没有问答」，**绝不因此丢掉这条
 * 候选** —— 列表是用户找回自己对话的唯一入口，为了一点装饰性信息丢条目是
 * 本末倒置。
 */
export async function listConversationsForCwd(
  home: string,
  cwd: string,
): Promise<ConversationCandidate[]> {
  const records = await listConversationRecords(home);
  const kept = candidatesForCwd(records.map((r) => r.candidate), cwd);

  // id → 文件路径。同一个 id 出现在两个 project 目录下是可能的（同一个会话被
  // 复制过），但落在**同一个 cwd** 下就不可能同时存在两条 —— 后者才是这里会
  // 撞键的场景，故取先出现的那条即可。
  const fileById = new Map(records.map((r) => [r.candidate.id, r.file]));

  return mapLimited(kept, CONCURRENCY, async (candidate) => {
    const file = fileById.get(candidate.id);
    if (file === undefined) return candidate;
    try {
      const tail = await readTail(file, TAIL_BYTES);
      const { question, answer } = parseConversationTail(tail);
      return {
        ...candidate,
        ...(question !== undefined ? { lastQuestion: question } : {}),
        ...(answer !== undefined ? { lastAnswer: answer } : {}),
      };
    } catch {
      return candidate; // 读不动就当没有问答，候选照常返回
    }
  });
}
