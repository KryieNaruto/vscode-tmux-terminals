import { Profile, TerminalEntry } from './types';

/**
 * v1 → v2 条目迁移。
 *
 * v1 形态：{ id, name, cwd, commands: string[], autoRestore }
 * v2 形态：{ id, name, cwd, profile, model?, autoRestore, order }
 *
 * **为什么必须存在：** EntryStore.load() 把 migrateEntry 当作**唯一的守门
 * 人** —— 载入时没有别的过滤阶段，只跑 migrateEntry；它返回 undefined 的
 * 条目即被丢弃。因此迁移必须**保留所有必需字段**（而不是拒绝不熟悉的
 * 字段）：否则用户已有的 v1 条目会被**静默丢弃**（远端实测 6 条）。
 *
 * 迁移是幂等的：已是 v2 形态的条目原样返回。
 */

export function isV1Shape(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.commands);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
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

  // 已是 v2：原样返回，保证幂等
  if (!isV1Shape(o)) {
    const profile: Profile = o.profile === 'direct' ? 'direct' : 'ccr';
    const model = str(o.model);
    return {
      id, name, cwd, profile,
      ...(model !== undefined && model.length > 0 ? { model } : {}),
      autoRestore: o.autoRestore === true,
      order: typeof o.order === 'number' ? o.order : index,
    };
  }

  // v1 → v2
  const commands = o.commands as unknown[];
  if (!commands.every((c) => typeof c === 'string')) return undefined;

  // 只要有一条命令用了 claude-direct 就判为 direct —— 用户的直接意图
  const joined = (commands as string[]).join('\n');
  const profile: Profile = /(^|\s|\/)claude-direct(\s|$)/.test(joined) ? 'direct' : 'ccr';

  return {
    id, name, cwd, profile,
    autoRestore: o.autoRestore === true,
    order: index,
  };
}
