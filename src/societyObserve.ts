import * as fs from 'fs';
import { SocietyRole } from './core/society';
import { TerminalEntry } from './core/types';
import { sessionNameFor } from './core/tmux';
import { memoryFilePath } from './roster';
import { messagesPath } from './messaging';

/** messages.md 里解析出的一条消息。 */
export interface SocietyMessage {
  time: string;  // 原文 'YYYY-MM-DD HH:mm:ss'
  from: string;  // 发件人角色 ID
  to: string;    // 收件人终端 ID
  body: string;  // 正文（多行原样，已 trim 首尾空行）
}

/** 消息标题行：`## <时间> · <发件人> → <收件人>`。正文里不会出现同形态的行。 */
const HEADER_RE = /^## (.+?) · (.+?) → (.+?)\s*$/;

/** 记忆文件头部的名字行：`- 名字：阿离`。 */
const NAME_RE = /名字[:：]\s*(.+)/m;

/** 读 role 的 memory.md,提取 AI 自起的名字;未起名/读失败/文件不存在 → ''。 */
export function readName(role: SocietyRole): string {
  try {
    const text = fs.readFileSync(memoryFilePath(role), 'utf8');
    const name = NAME_RE.exec(text)?.[1].trim() ?? '';
    // 模板里的占位符「（待起）」不是名字；空串同理，两者都交给调用方回落。
    return name.length === 0 || name.includes('待起') ? '' : name;
  } catch {
    return '';
  }
}

/** 解析 messages.md → 按文件顺序的消息数组;文件不存在/空 → []。 */
export function parseMessages(rootDir: string): SocietyMessage[] {
  let text: string;
  try {
    text = fs.readFileSync(messagesPath(rootDir), 'utf8');
  } catch {
    return [];
  }
  const out: SocietyMessage[] = [];
  let current: SocietyMessage | undefined;
  for (const raw of text.split('\n')) {
    const header = HEADER_RE.exec(raw);
    if (header !== null) {
      if (current !== undefined) out.push(current);
      current = { time: header[1], from: header[2], to: header[3], body: '' };
      continue;
    }
    // 第一条标题行之前的杂行（手工写的前言等）一律忽略。
    if (current === undefined) continue;
    const line = raw.trim();
    if (line.length === 0) continue;
    current.body = current.body.length === 0 ? line : `${current.body}\n${line}`;
  }
  // 文件末尾的消息没有下一个标题行收尾，这里补上（body 的尾空行已在循环里跳过）。
  if (current !== undefined) out.push(current);
  return out;
}

/** role → 终端 ID(session name);无 entry / 无 session → ''。 */
export function terminalIdFor(role: SocietyRole, entries: TerminalEntry[]): string {
  const entry = entries.find((e) => e.id === role.terminalEntryId);
  const slot = entry?.sessions[0];
  return slot === undefined ? '' : sessionNameFor(slot.id);
}

/** 该 role 发出的最后一条消息;没发过 → undefined。 */
export function lastOutbound(
  role: SocietyRole,
  entries: TerminalEntry[],
  messages: SocietyMessage[],
): SocietyMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].from === role.id) return messages[i];
  }
  return undefined;
}

/** 该 role 忙/空闲:发(from===role.id)或收(to===terminalIdFor(role))的最后一条消息时间距今 < thresholdMs → '忙',否则 '空闲'。 */
export function roleStatus(
  role: SocietyRole,
  entries: TerminalEntry[],
  messages: SocietyMessage[],
  now: number,
  thresholdMs: number,
): '忙' | '空闲' {
  const self = terminalIdFor(role, entries);
  let latestMs = -Infinity;
  for (const m of messages) {
    if (m.from !== role.id && (self.length === 0 || m.to !== self)) continue;
    const ms = new Date(m.time.replace(' ', 'T')).getTime();
    if (!Number.isNaN(ms) && ms > latestMs) latestMs = ms;
  }
  if (latestMs === -Infinity) return '空闲';
  return now - latestMs < thresholdMs ? '忙' : '空闲';
}

/** 把消息里的收件人终端 ID 换成角色名;在 roles+entries 里找不到 → 原样返回终端 ID。 */
export function resolveToName(
  terminalId: string,
  roles: SocietyRole[],
  entries: TerminalEntry[],
): string {
  // 空 ID 不参与匹配：否则会命中「还没建会话」的角色（它们也返回空串）。
  if (terminalId.length === 0) return terminalId;
  for (const r of roles) {
    if (terminalIdFor(r, entries) === terminalId) {
      return (r.name || readName(r) || r.duty).replace(/\s+/g, ' ');
    }
  }
  return terminalId;
}
