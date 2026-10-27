import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Society, SocietyRole, levelLabel } from './core/society';
import { TerminalEntry } from './core/types';
import { sessionNameFor } from './core/tmux';
import { readName, roleStatus, parseMessages } from './societyObserve';

/** 全局身份表在 society 根目录下的位置。 */
export function globalRosterPath(rootDir: string): string {
  return path.join(rootDir, '.society', 'global.md');
}

/** 角色记忆文件路径 —— 与 societyCommands.seedRoleDir 的落点同源（由 role.id 派生）。 */
export function memoryFilePath(role: SocietyRole): string {
  return path.join(role.dir, '.society', 'roles', role.id, 'memory.md');
}

interface RosterRow {
  name: string;
  levelLabel: string;
  /** 角色 ID：AI 之间发消息时用它当发件人标识，必须能在身份表里查到。 */
  roleId: string;
  duty: string;
  dir: string;
  memory: string;
  terminalId: string;
  conversationId: string;
  online: boolean;
  /** 忙/空闲，由 renderRoster 统一算（rowFor 单跑时不知道消息）。 */
  status: string;
}

function rowFor(role: SocietyRole, entries: TerminalEntry[], alive: ReadonlySet<string>): RosterRow {
  const entry = entries.find((e) => e.id === role.terminalEntryId);
  const slot = entry?.sessions[0];
  const terminalId = slot === undefined ? '' : sessionNameFor(slot.id);
  const online = terminalId.length > 0 && alive.has(terminalId);
  // duty 是用户自由输入，可能含换行/井号，落进 markdown 前压成单行，避免破坏结构。
  // 名字优先：AI 自起名 → memory.md 里的名字 → 职责（还没起名时的兜底）。
  const name = (role.name || readName(role) || role.duty).replace(/\s+/g, ' ');
  return {
    name,
    levelLabel: levelLabel(role.level),
    roleId: role.id,
    duty: role.duty.replace(/\s+/g, ' '),
    dir: role.dir,
    memory: memoryFilePath(role),
    terminalId,
    conversationId: slot?.conversationId ?? '',
    online,
    status: '',
  };
}

export function renderRoster(society: Society, entries: TerminalEntry[], alive: ReadonlySet<string>): string {
  const messages = parseMessages(society.rootDir);
  const now = Date.now();
  const rows = society.roles.map((r) => {
    const row = rowFor(r, entries, alive);
    row.status = roleStatus(r, entries, messages, now, 5 * 60 * 1000);
    return row;
  });
  const online = rows.filter((r) => r.online).length;
  const lines: string[] = [
    `# 全局身份表 — ${society.name}`,
    '',
    '> 本文件由扩展自动生成，勿手改。AI 找其他成员协作时，先读这里再决定找谁。',
    '',
    `成员 ${rows.length} 个（在线 ${online} / 离线 ${rows.length - online}）`,
    `更新时间：${new Date().toISOString()}`,
    '',
  ];
  if (rows.length === 0) {
    lines.push('（暂无成员）', '');
  } else {
    for (const r of rows) {
      lines.push(`## ${r.name}`, '');
      lines.push(`- 层级：${r.levelLabel}`);
      lines.push(`- 角色 ID：${r.roleId}`);
      lines.push(`- 职责：${r.duty}`);
      lines.push(`- 工作目录：${r.dir}`);
      lines.push(`- 记忆文件：${r.memory}`);
      lines.push(`- 终端 ID：${r.terminalId}`);
      lines.push(`- 会话 ID：${r.conversationId}`);
      lines.push(`- 状态：${r.online ? '在线' : '离线'}`);
      lines.push(`- 工作状态：${r.status}`, '');
    }
  }
  return lines.join('\n');
}

export function writeGlobalRoster(society: Society, entries: TerminalEntry[], alive: ReadonlySet<string>): void {
  const file = globalRosterPath(society.rootDir);
  const content = renderRoster(society, entries, alive);
  // 内容没变就不写：轮询里每 10s 调一次，稳态不该反复 rename 同一个文件。
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    // 不存在 → 照常写
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清临时文件失败不能盖掉真正要报的错
    }
    throw err;
  }
}
