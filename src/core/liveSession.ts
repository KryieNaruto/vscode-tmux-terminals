/**
 * `~/.claude/sessions/<pid>.json`（会话注册表）的解析与候选去重。
 *
 * 本文件刻意不依赖 vscode、也不碰文件系统（IO 在 src/liveSessions.ts）。
 *
 * **这是 claude 的内部实现** —— 解析不出就返回 undefined（= 退化为「不观测」），
 * 绝不容错到编造一个 id。将来它改名/改格式，症状是「绑定不再自动跟随」
 * （退回本功能之前的行为），而**不是**绑错对话。
 */

/** 一条 `~/.claude/sessions/<pid>.json` 里我们需要的字段。 */
export interface SessionRecord {
  pid: number;
  sessionId: string;
  /** claude 进程自记的启动时刻（ms）。同一 pane 下有多个 claude 后代时用它做确定性 tie-break。 */
  startedAt: number;
  cwd: string;
}

/**
 * 解析注册表文件。缺 `pid`/`sessionId`/`startedAt`、非对象、非 JSON、
 * **`sessionId` 为空串或纯空白**一律返回 undefined。
 *
 * 空串判 undefined 是必须的：否则它会一路传到 reconcileBinding 把绑定写成
 * `''`（= 清空绑定）。
 *
 * `cwd` 缺失时取空串（「未知」），绝不编造一个路径；它只用于诊断，
 * 不参与任何判据 —— 归属一律以条目自己的 `cwdFor()` 为准。
 */
export function parseSessionRecord(text: string): SessionRecord | undefined {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof o !== 'object' || o === null) return undefined;
  const rec = o as Record<string, unknown>;

  const pid = rec.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;

  const sessionId = rec.sessionId;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return undefined;

  const startedAt = rec.startedAt;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return undefined;

  const cwd = typeof rec.cwd === 'string' ? rec.cwd : '';
  return { pid, sessionId, startedAt, cwd };
}

/**
 * 从候选里挑「这个 pane 此刻真的在用的那条会话」。
 * - 空数组 → undefined
 * - 按 `startedAt` 取**最新**；并列时按 pid 大者 → 结果确定，不随
 *   readdir / 进程表顺序抖动
 *
 * 如实说明：实测到的孤儿场景（两个 pid 记同一条 sessionId）里取新取旧
 * 结果**相同**；这条规则是为「多个 claude 各记不同 sessionId」这一更一般
 * 的情形兜底，不是为孤儿场景服务的。
 */
export function pickLiveSession(records: readonly SessionRecord[]): SessionRecord | undefined {
  let best: SessionRecord | undefined;
  for (const rec of records) {
    if (
      best === undefined ||
      rec.startedAt > best.startedAt ||
      (rec.startedAt === best.startedAt && rec.pid > best.pid)
    ) {
      best = rec;
    }
  }
  return best;
}
