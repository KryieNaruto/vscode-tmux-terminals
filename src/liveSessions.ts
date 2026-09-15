import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { SessionRecord, parseSessionRecord, pickLiveSession } from './core/liveSession';
import { ProcNode, descendantsOf, parseProcTable } from './core/processTree';

const run = promisify(execFile);

/**
 * 「这一刻系统里有哪些进程、claude 的会话注册表里都记着谁」的一次性快照。
 *
 * **整批条目共用一份** —— 一次 reconcile 只 spawn 一次 `ps`、只 readdir 一次
 * 注册表，绝不按条目各查一遍。
 */
export interface LivenessSnapshot {
  readonly procs: readonly ProcNode[];
  /** 注册表按 pid 索引（注册表只有个位数文件、每个 ~350 B，整体读入即可） */
  readonly sessions: ReadonlyMap<number, SessionRecord>;
}

/** 读一次快照。`ps` 失败 / 注册表目录不存在都返回空快照，绝不抛。 */
export async function readLiveness(home: string): Promise<LivenessSnapshot> {
  return { procs: await readProcTable(), sessions: await readSessions(home) };
}

/** `ps -eo pid=,ppid=`：等号让 ps 省掉表头，输出即 `  pid  ppid` 两列。 */
async function readProcTable(): Promise<ProcNode[]> {
  try {
    const { stdout } = await run('ps', ['-eo', 'pid=,ppid=']);
    return parseProcTable(stdout);
  } catch {
    return []; // ps 不可用 → 空进程表（= 观测不到，不是猜）
  }
}

async function readSessions(home: string): Promise<Map<number, SessionRecord>> {
  const dir = path.join(home, '.claude', 'sessions');
  const out = new Map<number, SessionRecord>();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return out; // 没有 ~/.claude/sessions —— 正常情况（从没用过 claude）
  }
  // 注册表只有个位数文件、每个几百字节，串行读完即可，不值得引入并发。
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = parseSessionRecord(await fs.readFile(path.join(dir, name), 'utf8'));
      if (record !== undefined) out.set(record.pid, record);
    } catch {
      // 单个文件读不动 / 内容不合规 → 跳过，不影响其余
    }
  }
  return out;
}

/**
 * 从快照解析出某个 pane 下「最后用过的会话」。
 * 取不到（进程表查不到 pane、没有后代 claude、注册表里没有它）→ undefined。
 * **解析不出就是解析不出，不猜。**
 */
export function liveSessionIn(snap: LivenessSnapshot, panePid: number): SessionRecord | undefined {
  const hits: SessionRecord[] = [];
  for (const pid of descendantsOf(snap.procs, panePid)) {
    const record = snap.sessions.get(pid);
    if (record !== undefined) hits.push(record);
  }
  return pickLiveSession(hits);
}
