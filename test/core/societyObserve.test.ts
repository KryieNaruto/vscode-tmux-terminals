import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SocietyRole } from '../../src/core/society';
import { TerminalEntry } from '../../src/core/types';
import {
  readName,
  parseMessages,
  terminalIdFor,
  lastOutbound,
  roleStatus,
  resolveToName,
  SocietyMessage,
} from '../../src/societyObserve';

/** 本地时间 'YYYY-MM-DD HH:mm:ss' —— 与 messages.md 的标题行格式一致。 */
function fmt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function makeRole(id: string, name = '', terminalEntryId = 'entry1'): SocietyRole {
  return { id, name, level: 'dev', duty: '写代码', dir: '', terminalEntryId };
}

function makeEntry(id: string, slotId: string): TerminalEntry {
  return {
    id,
    name: id,
    cwd: '/tmp',
    profile: 'ccr',
    autoRestore: false,
    order: 0,
    sessions: [{ id: slotId, conversationId: '', order: 0 }],
  };
}

function writeMessages(rootDir: string, content: string): void {
  fs.mkdirSync(path.join(rootDir, '.society'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.society', 'messages.md'), content, 'utf8');
}

describe('societyObserve', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'society-observe-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('readName 取 memory.md 头部的名字，未起名/待起/文件不存在 → 空串', () => {
    const named = makeRole('aaaaaaaaaaaa');
    named.dir = root;
    const memDir = path.join(root, '.society', 'roles', named.id);
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'memory.md'), '# 记忆\n\n- 名字：阿离\n', 'utf8');
    assert.strictEqual(readName(named), '阿离');

    const pending = makeRole('bbbbbbbbbbbb');
    pending.dir = root;
    const pendingDir = path.join(root, '.society', 'roles', pending.id);
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'memory.md'), '- 名字：（待起）\n', 'utf8');
    assert.strictEqual(readName(pending), '');

    const missing = makeRole('cccccccccccc');
    missing.dir = root;
    assert.strictEqual(readName(missing), '');
  });

  it('parseMessages 解析标题行与多行正文，按文件顺序返回', () => {
    writeMessages(root, [
      '前言杂行忽略',
      '',
      '## 2026-10-26 10:00:00 · aaaaaaaaaaaa → tmuxterm-111',
      '',
      '第一行',
      '第二行',
      '',
      '## 2026-10-26 10:05:00 · bbbbbbbbbbbb → tmuxterm-222',
      '',
      '单行正文',
      '',
    ].join('\n'));

    const msgs = parseMessages(root);
    assert.strictEqual(msgs.length, 2);
    assert.deepStrictEqual(msgs[0], {
      time: '2026-10-26 10:00:00',
      from: 'aaaaaaaaaaaa',
      to: 'tmuxterm-111',
      body: '第一行\n第二行',
    });
    assert.strictEqual(msgs[1].body, '单行正文');
  });

  it('parseMessages 文件不存在 → []', () => {
    assert.deepStrictEqual(parseMessages(root), []);
  });

  it('roleStatus 刚发过 → 忙，很久前 → 空闲，无消息 → 空闲', () => {
    const role = makeRole('aaaaaaaaaaaa');
    const entries = [makeEntry('entry1', 'slot1')];
    const now = Date.now();
    const terminal = terminalIdFor(role, entries);

    const busy: SocietyMessage[] = [
      { time: fmt(now - 1000), from: role.id, to: terminal, body: '在做' },
    ];
    assert.strictEqual(roleStatus(role, entries, busy, now, 5 * 60 * 1000), '忙');

    const idle: SocietyMessage[] = [
      { time: fmt(now - 60 * 60 * 1000), from: role.id, to: terminal, body: '很久前' },
    ];
    assert.strictEqual(roleStatus(role, entries, idle, now, 5 * 60 * 1000), '空闲');

    assert.strictEqual(roleStatus(role, entries, [], now, 5 * 60 * 1000), '空闲');
  });

  it('lastOutbound 返回该角色发出的最后一条', () => {
    const role = makeRole('aaaaaaaaaaaa');
    const messages: SocietyMessage[] = [
      { time: '2026-10-26 10:00:00', from: role.id, to: 'tmuxterm-111', body: '一' },
      { time: '2026-10-26 10:01:00', from: 'bbbbbbbbbbbb', to: 'tmuxterm-222', body: '别人' },
      { time: '2026-10-26 10:02:00', from: role.id, to: 'tmuxterm-111', body: '二' },
    ];
    assert.strictEqual(lastOutbound(role, [], messages)?.body, '二');
  });

  it('terminalIdFor 由会话槽派生终端 ID', () => {
    const role = makeRole('aaaaaaaaaaaa');
    const entries = [makeEntry('entry1', 'slot1')];
    assert.strictEqual(terminalIdFor(role, entries), 'tmuxterm-slot1');
    assert.strictEqual(terminalIdFor(role, []), '');
  });

  it('resolveToName 命中返回角色名，未命中原样返回终端 ID', () => {
    const role = makeRole('aaaaaaaaaaaa', '阿离');
    const entries = [makeEntry('entry1', 'slot1')];
    assert.strictEqual(resolveToName('tmuxterm-slot1', [role], entries), '阿离');
    assert.strictEqual(resolveToName('tmuxterm-unknown', [role], entries), 'tmuxterm-unknown');
  });
});
