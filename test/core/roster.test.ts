import * as assert from 'assert';
import { renderRoster, memoryFilePath, globalRosterPath } from '../../src/roster';
import { Society, SocietyRole } from '../../src/core/society';
import { TerminalEntry } from '../../src/core/types';
import { sessionNameFor } from '../../src/core/tmux';

const role = (over: Partial<SocietyRole> = {}): SocietyRole => ({
  id: 'role1',
  name: '',
  level: 'dev',
  duty: '安卓开发',
  dir: '/proj/apps/android',
  terminalEntryId: 'entry1',
  ...over,
});

const entry = (over: Partial<TerminalEntry> = {}): TerminalEntry => ({
  id: 'entry1',
  name: '安卓开发',
  cwd: '/proj/apps/android',
  profile: 'ccr',
  autoRestore: true,
  order: 0,
  sessions: [{ id: 'slot1', conversationId: 'conv-1', order: 0 }],
  ...over,
});

describe('renderRoster', () => {
  it('终端 id 在存活集里判在线', () => {
    const society: Society = { id: 's1', name: '投屏', rootDir: '/proj', roles: [role()] };
    const alive = new Set([sessionNameFor('slot1')]);
    const out = renderRoster(society, [entry()], alive);
    assert.ok(out.includes('成员 1 个（在线 1 / 离线 0）'));
    assert.ok(out.includes('- 状态：在线'));
  });

  it('终端 id 不在存活集里判离线', () => {
    const society: Society = { id: 's1', name: '投屏', rootDir: '/proj', roles: [role()] };
    const out = renderRoster(society, [entry()], new Set<string>());
    assert.ok(out.includes('- 状态：离线'));
  });

  it('角色名字为空时回落职责当标题', () => {
    const society: Society = { id: 's1', name: '投屏', rootDir: '/proj', roles: [role({ name: '', duty: '安卓开发' })] };
    const out = renderRoster(society, [entry()], new Set<string>());
    assert.ok(out.includes('## 安卓开发'));
  });

  it('记忆文件与全局表路径由角色 id / 根目录派生', () => {
    assert.strictEqual(memoryFilePath(role({ id: 'abc', dir: '/proj/x' })), '/proj/x/.society/roles/abc/memory.md');
    assert.strictEqual(globalRosterPath('/proj'), '/proj/.society/global.md');
  });
});
