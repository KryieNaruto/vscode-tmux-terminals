import * as assert from 'assert';
import {
  ConversationCandidate,
  belongsToCwd,
  candidatesForCwd,
  formatBytes,
  formatCandidate,
  formatCandidateWithOwner,
  ownersOf,
  parseConversationHead,
} from '../../src/core/conversation';

/** 造一行 .jsonl。真实文件里 cwd 出现在大多数行上（mode/snapshot 行没有）。 */
const line = (o: object) => JSON.stringify(o);

const USER_LINE = (text: string, extra: object = {}) =>
  line({
    type: 'user', userType: 'external', isSidechain: false, cwd: '/a/b',
    message: { role: 'user', content: text }, ...extra,
  });

const c = (patch: Partial<ConversationCandidate> = {}): ConversationCandidate => ({
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  cwd: '/a/b',
  mtimeMs: 1_700_000_000_000,
  bytes: 2048,
  summary: '改一下 bug',
  ...patch,
});

describe('parseConversationHead —— 从 .jsonl 头部提取 cwd 与首条用户消息', () => {
  it('跳过 mode / snapshot / attachment 之类的非用户行', () => {
    const text = [
      line({ type: 'mode', sessionId: 'x' }),
      line({ type: 'file-history-snapshot', snapshot: {} }),
      line({ type: 'attachment', cwd: '/a/b', attachment: {} }),
      USER_LINE('帮我改一下 bug'),
    ].join('\n');
    assert.deepStrictEqual(parseConversationHead(text), {
      cwd: '/a/b',
      summary: '帮我改一下 bug',
    });
  });

  it('cwd 取自文件里记录的字段，不靠目录名转义规则反推', () => {
    // 实测 `_` 和 `.` 也会被换成 `-`，目录名不可靠
    const text = [line({ type: 'attachment', cwd: '/a/b_c.d/e' }), USER_LINE('hi')].join('\n');
    assert.strictEqual(parseConversationHead(text).cwd, '/a/b_c.d/e');
  });

  it('content 是分块数组时取第一个 text 块', () => {
    const text = [
      line({ type: 'attachment', cwd: '/a/b' }),
      line({
        type: 'user', userType: 'external', isSidechain: false, cwd: '/a/b',
        message: { role: 'user', content: [{ type: 'text', text: '分块消息' }] },
      }),
    ].join('\n');
    assert.strictEqual(parseConversationHead(text).summary, '分块消息');
  });

  it('忽略 isSidechain 的子代理消息（不是用户敲的）', () => {
    const text = [
      line({ type: 'attachment', cwd: '/a/b' }),
      USER_LINE('子代理噪音', { isSidechain: true }),
      USER_LINE('真正由用户敲的'),
    ].join('\n');
    assert.strictEqual(parseConversationHead(text).summary, '真正由用户敲的');
  });

  it('忽略只有 tool_result 的 user 行（那是工具回执，不是用户消息）', () => {
    const text = [
      line({ type: 'attachment', cwd: '/a/b' }),
      line({
        type: 'user', userType: 'external', isSidechain: false,
        message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
      }),
      USER_LINE('用户说的话'),
    ].join('\n');
    assert.strictEqual(parseConversationHead(text).summary, '用户说的话');
  });

  it('末行被截断（只读了文件头部）不抛错，已解析出的部分保留', () => {
    const text = [line({ type: 'attachment', cwd: '/a/b' }), '{"type":"user","message":{"conten'].join('\n');
    assert.deepStrictEqual(parseConversationHead(text), { cwd: '/a/b' });
  });

  it('摘要压平换行并截断，避免 QuickPick 里多行错位', () => {
    const text = [line({ type: 'attachment', cwd: '/a/b' }), USER_LINE('第一行\n\n第二行   第三行')].join('\n');
    assert.strictEqual(parseConversationHead(text).summary, '第一行 第二行 第三行');

    const long = 'x'.repeat(500);
    const s = parseConversationHead([line({ type: 'attachment', cwd: '/a/b' }), USER_LINE(long)].join('\n')).summary;
    assert.ok(s !== undefined && s.length <= 61, `实际长度 ${s?.length}`);
    assert.ok(s !== undefined && s.endsWith('…'));
  });

  it('什么都解析不出来时返回空对象（绝不编造）', () => {
    assert.deepStrictEqual(parseConversationHead(''), {});
    assert.deepStrictEqual(parseConversationHead('不是 json\n{也,不是}'), {});
  });
});

describe('belongsToCwd —— 对话归属判据', () => {
  it('精确相等才算同一条目', () => {
    assert.strictEqual(belongsToCwd('/a/b', '/a/b'), true);
  });
  it('忽略末尾斜杠差异', () => {
    assert.strictEqual(belongsToCwd('/a/b/', '/a/b'), true);
    assert.strictEqual(belongsToCwd('/a/b', '/a/b///'), true);
  });
  it('★ 前缀相近不是同一个目录（/a/b 与 /a/bc）', () => {
    assert.strictEqual(belongsToCwd('/a/bc', '/a/b'), false);
    assert.strictEqual(belongsToCwd('/a/b/c', '/a/b'), false);
  });
  it('完全不同 / 空串 → false', () => {
    assert.strictEqual(belongsToCwd('/x', '/a/b'), false);
    assert.strictEqual(belongsToCwd('', '/a/b'), false);
    assert.strictEqual(belongsToCwd('/a/b', ''), false);
  });
});

describe('candidatesForCwd —— 候选枚举', () => {
  it('只留下该 cwd 的，并按 mtime 倒序（新的在前）', () => {
    const items = [
      c({ id: 'old', mtimeMs: 100, cwd: '/a/b' }),
      c({ id: 'other', mtimeMs: 999, cwd: '/other' }),
      c({ id: 'new', mtimeMs: 500, cwd: '/a/b' }),
    ];
    assert.deepStrictEqual(candidatesForCwd(items, '/a/b').map((x) => x.id), ['new', 'old']);
  });
  it('mtime 相同时按 id 稳定排序（避免每次弹出顺序不同）', () => {
    const items = [c({ id: 'bbb', mtimeMs: 1 }), c({ id: 'aaa', mtimeMs: 1 })];
    assert.deepStrictEqual(candidatesForCwd(items, '/a/b').map((x) => x.id), ['aaa', 'bbb']);
  });
  it('没有归属该 cwd 的对话时返回空数组', () => {
    assert.deepStrictEqual(candidatesForCwd([c({ cwd: '/other' })], '/a/b'), []);
  });
});

describe('formatBytes / formatCandidate —— QuickPick 显示', () => {
  it('体积分档可读', () => {
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1024), '1.0 KB');
    assert.strictEqual(formatBytes(1536), '1.5 KB');
    assert.strictEqual(formatBytes(20480), '20 KB');
    assert.strictEqual(formatBytes(1048576), '1.0 MB');
  });
  it('候选行含时间、摘要、体积', () => {
    const s = formatCandidate(c({ summary: '改一下 bug', bytes: 2048 }));
    assert.ok(s.includes('改一下 bug'), s);
    assert.ok(s.includes('2.0 KB'), s);
    assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s), s);
  });
  it('没有摘要时明说，不显示空档', () => {
    assert.ok(formatCandidate(c({ summary: '' })).includes('（无摘要）'));
  });
});

describe('ownersOf —— 哪些对话已经被别的条目绑走', () => {
  const E = (id: string, name: string, conversationId?: string) => ({ id, name, conversationId });

  it('收集「别的条目 → 它绑的对话」', () => {
    const m = ownersOf([E('a', '甲', 'conv-1'), E('b', '乙', 'conv-2')], 'self');
    assert.strictEqual(m.get('conv-1'), '甲');
    assert.strictEqual(m.get('conv-2'), '乙');
  });

  it('★ 跳过自己（自己当然绑着这条）', () => {
    const m = ownersOf([E('self', '我', 'conv-1')], 'self');
    assert.strictEqual(m.get('conv-1'), undefined);
  });

  it('跳过未绑定 / 空串 / 缺字段的条目', () => {
    const m = ownersOf([E('a', '甲'), E('b', '乙', ''), { id: 'c', name: '丙' }], 'self');
    assert.strictEqual(m.size, 0);
  });

  it('多条条目绑了同一个 id 时取先出现的（顺序稳定，不随后续条目抖动）', () => {
    const m = ownersOf([E('a', '甲', 'conv-1'), E('b', '乙', 'conv-1')], 'self');
    assert.strictEqual(m.get('conv-1'), '甲');
  });
});

describe('formatCandidateWithOwner —— 选择框里标注归属', () => {
  it('没人绑过时与普通行完全一致', () => {
    assert.strictEqual(formatCandidateWithOwner(c()), formatCandidate(c()));
  });
  it('已被绑走时附上归属者，用户能看出「这是别人的」', () => {
    const s = formatCandidateWithOwner(c(), 'UI_Worker-01');
    assert.ok(s.includes('已绑给「UI_Worker-01」'), s);
    assert.ok(s.startsWith(formatCandidate(c())), s);
  });
});
