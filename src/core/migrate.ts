import { Profile, SessionSlot, TerminalEntry } from './types';

/**
 * v1 / v2 → v3 条目迁移。
 *
 * v1 形态：{ id, name, cwd, commands: string[], autoRestore }
 * v2 形态：{ id, name, cwd, profile, model?, conversationId?, liveSessionId?, autoRestore, order }
 * v3 形态：{ id, name, cwd, profile, model?, color?, sessions: SessionSlot[], autoRestore, order }
 *
 * **为什么必须存在：** EntryStore.load() 把 migrateEntry 当作**唯一的守门
 * 人** —— 载入时没有别的过滤阶段，只跑 migrateEntry；它返回 undefined 的
 * 条目即被丢弃。因此迁移必须**保留所有必需字段**（而不是拒绝不熟悉的
 * 字段）：否则用户已有的 v1 条目会被**静默丢弃**（远端实测 6 条）。
 *
 * 迁移是幂等的：已是 v3 形态的条目原样返回。
 */

export function isV1Shape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.commands);
}

/**
 * v2 形态的判据：有 string 的 id/name/cwd，且**既没有** v1 的 commands 数组、
 * **也没有** v3 的 sessions 数组。
 *
 * 判据刻意是「两个数组都没有」而不是「有 profile」：store 的第二个备份入口
 * 靠它决定要不要写 `<file>.v2.bak`，而备份名必须**诚实** —— 写出来的那份得
 * 真的是 v2。用「有 profile」判会让 v3 文件也被当成 v2，备份出一个名叫
 * `.v2.bak` 却装着 v3 内容的文件，把「更晚、更接近现状」的那份状态保护成
 * 了一份错的东西。
 */
export function isV2Shape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.commands) || Array.isArray(o.sessions)) return false;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.cwd === 'string';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** 非空 string 才算数：缺字段 / 空串 / 非字符串一律视为**未设**，绝不编造一个 id。 */
function nonEmpty(v: unknown): string | undefined {
  const s = str(v);
  return s !== undefined && s.length > 0 ? s : undefined;
}

/** 可选字段的落盘形态：有值才带上键，否则整键不出现（`undefined` 也是「有键」）。 */
function opt(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * 校验并迁移单个 v3 槽。返回 undefined = **丢弃该槽**。
 *
 * 丢槽是本次唯一的丢弃路径，只有手改坏了文件才会命中，且不影响同条目的其它槽。
 * 判据刻意保持**确定性**：`load()` 每次读都会跑 migrateEntry，而迁移结果只在
 * 下次真实写入时才落盘 —— 若这里给缺 id 的槽现场编一个随机 id，同一份文件
 * 两次读会得到**不同的 tmux 名**，树在写入发生前一直抖。故丢，不编。
 */
function migrateSlot(raw: unknown, index: number): SessionSlot | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  // id 不是非空 string → 丢：它没有地址，tmux 会话名无从派生，留着也没法用。
  const id = nonEmpty(o.id);
  if (id === undefined) return undefined;
  return {
    id,
    // 非字符串 / 空串 → 视为未设（绝不编造）。
    ...opt('conversationId', nonEmpty(o.conversationId)),
    ...opt('liveSessionId', nonEmpty(o.liveSessionId)),
    // order 非 number → 用该槽的下标（与条目 order 取 index 同一条退路）。
    order: typeof o.order === 'number' ? o.order : index,
  };
}

/**
 * 迁移单条。返回 undefined 表示该条无法迁移（缺必需字段），
 * 调用方应丢弃它而不是让整个清单读取失败。
 */
export function migrateEntry(raw: unknown, index: number): TerminalEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const o = raw as Record<string, unknown>;

  const id = str(o.id);
  const name = str(o.name);
  const cwd = str(o.cwd);
  if (id === undefined || name === undefined || cwd === undefined) return undefined;

  const profile: Profile = o.profile === 'direct' ? 'direct' : 'ccr';
  const model = nonEmpty(o.model);
  // color 是本轮新增的可选字段：v1/v2 都没有它 → undefined，语义正确；而手改
  // 文件里已经加过它的条目也要原样带过。**非法值不在这里挡** —— 写入路径
  // （setColorInteractive）已经把过关，这里再挡一次只会让手改的清单在每次
  // load 时静默变样；渲染端（iconFor）对非法值回落到中性竖线。
  const color = nonEmpty(o.color);

  // ---- 已是 v3：逐槽校验后原样带过 ----
  if (Array.isArray(o.sessions)) {
    const slots = (o.sessions as unknown[])
      .map((s, i) => migrateSlot(s, i))
      .filter((s): s is SessionSlot => s !== undefined);
    return {
      id, name, cwd, profile,
      ...opt('model', model),
      ...opt('color', color),
      sessions: slots,
      autoRestore: o.autoRestore === true,
      order: typeof o.order === 'number' ? o.order : index,
    };
    // 注意上面**绝不**回头读顶层 conversationId 复活一个槽：`sessions: []` 是
    // v3 的合法状态（用户把会话都删了），复活它等于凭空造一个会话。
    // 只有 sessions 字段整体缺失（v1/v2）才合成槽。
  }

  // ---- v2 → v3：合成**恰好一个**槽 ----
  if (!isV1Shape(o)) {
    // 条目 ↔ 对话的绑定必须原样带过去。漏了这一行，迁移就会**静默吞掉**
    // 用户的绑定 —— 下一次恢复又变成「新建一条对话顶掉原来的」。
    const conversationId = nonEmpty(o.conversationId);
    // 「上一次观测到的活跃会话」同样必须原样带过。漏这一行不是「字段丢了」
    // 这么轻 —— migrateEntry 是 EntryStore.load() 的**唯一守门人**，漏掉它
    // 等于每次 load 都把它静默吞掉，手动改绑保护随之失效，且没有任何报错。
    // 缺字段 / 空串 / 非字符串一律视为「从未观测过」：绝不编造一个 id。
    const liveSessionId = nonEmpty(o.liveSessionId);
    return {
      id, name, cwd, profile,
      ...opt('model', model),
      ...opt('color', color),
      // **槽 id 取原条目 id**：这是整个迁移里唯一不能写错的一行（理由见
      // types.ts 的 SessionSlot 注释）。v2 的 tmux 会话名就是
      // `tmuxterm-<entryId>`，换成别的 id 会让用户升级后看见「本在运行的会话
      // 变成了『无会话』」，而真正的 claude 还在后台跑。
      sessions: [{
        id,
        ...opt('conversationId', conversationId),
        ...opt('liveSessionId', liveSessionId),
        order: 0,
      }],
      autoRestore: o.autoRestore === true,
      order: typeof o.order === 'number' ? o.order : index,
    };
  }

  // ---- v1 → v3 ----
  const commands = o.commands as unknown[];
  if (!commands.every((c) => typeof c === 'string')) return undefined;

  // 只要有一条命令用了 claude-direct 就判为 direct —— 用户的直接意图
  const joined = (commands as string[]).join('\n');
  const v1Profile: Profile = /(^|\s|\/)claude-direct(\s|$)/.test(joined) ? 'direct' : 'ccr';

  return {
    id, name, cwd, profile: v1Profile,
    // v1 **也必须有槽，不能给 `sessions: []`**：v1 的 tmux 会话名同样是
    // `tmuxterm-<entryId>`（会话名由条目 id 派生这条规则从 v1 起就没变过）。
    // 给空槽的后果是老用户升级后，那个正在跑的 claude **在树上没有任何一行
    // 可以点**，条目还是个不可展开的哑节点 —— 既接不回也杀不掉，只能去命令行
    // `tmux attach`。v1 与 v2 的差别只在**槽里有没有对话绑定**（v1 没有对话
    // 这个概念），槽本身两边都要有，槽 id 同样取原条目 id。
    sessions: [{ id, order: 0 }],
    autoRestore: o.autoRestore === true,
    order: index,
  };
}
