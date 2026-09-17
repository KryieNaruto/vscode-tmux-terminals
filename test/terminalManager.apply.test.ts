import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TerminalManager } from '../src/terminalManager';
import { EntryStore, newId } from '../src/core/store';
import { SessionSlot, TerminalEntry } from '../src/core/types';
import { sessionNameFor } from '../src/core/tmux';
import { FakeTmuxClient } from './support/fakeTmuxClient';
import { messages, resetVscodeMock } from './support/vscodeMock';

/**
 * 覆盖本次修复的核心行为：applyModel / applyProfile 过去对「存活槽」做
 * 「任一个前台不是 claude 就整体拒绝、一个都不改」的全有全无判断——而
 * 「tmux 会话存活」不等于「claude 还在跑」（用户 /exit、崩溃都会让会话
 * 活着但前台变回 bash）。实测三个条目、每个恰好一个槽退回 bash，导致
 * 这三个条目的切模型/切 profile 100% 被拒绝，即使用户点的是健康的那个
 * 三级会话（spec §7.5：三级转发到整个条目）。
 *
 * 修复后：跳过前台不是 claude 的槽（不算失败），只处理真正在跑 claude
 * 的槽；一个健康槽都没有时（等价于「没有 claude 在跑」）直接落配置、
 * 下次启动生效，不再整体拒绝——0.2.3 进一步把这条「整体拒绝」也纠正了
 * （之前只是把「跳过部分」的语义做对，「全部跳过」时仍误判成整体拒绝）。
 */

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxterm-applytest-')), 'terminals.json');
}

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxterm-applytest-home-'));
}

function slot(over: Partial<SessionSlot> = {}): SessionSlot {
  return { id: newId(), order: 0, ...over };
}

function entry(sessions: SessionSlot[], over: Partial<TerminalEntry> = {}): TerminalEntry {
  return {
    id: newId(),
    name: '测试终端',
    cwd: '~/mine/test',
    profile: 'ccr',
    autoRestore: false,
    order: 0,
    sessions,
    ...over,
  };
}

/** 覆写 home()，避免测试进程读到这台机器上真实的 ~/.claude/settings.json。 */
class TestTerminalManager extends TerminalManager {
  constructor(store: EntryStore, tmux: FakeTmuxClient, private readonly fakeHome: string) {
    super(store, tmux);
  }
  override home(): string {
    return this.fakeHome;
  }
}

function setup(): { mgr: TestTerminalManager; tmux: FakeTmuxClient; store: EntryStore } {
  const tmux = new FakeTmuxClient();
  const store = new EntryStore(tmpFile());
  const mgr = new TestTerminalManager(store, tmux, tmpHome());
  return { mgr, tmux, store };
}

const errorMsgs = () => messages.filter((m) => m.kind === 'error').map((m) => m.text);
const infoMsgs = () => messages.filter((m) => m.kind === 'info').map((m) => m.text);

describe('TerminalManager.applyModel —— 部分槽跳过、不再全有全无', () => {
  beforeEach(() => resetVscodeMock());

  it('3 个存活槽、1 个已退回 bash：跳过它，只给 2 个 claude 槽发 /model，整体算成功', async () => {
    const { mgr, tmux, store } = setup();
    const s1 = slot({ order: 0 });
    const s2 = slot({ order: 1 }); // 这个将处于 bash
    const s3 = slot({ order: 2 });
    const e = entry([s1, s2, s3]);
    await store.add(e);

    tmux.addSession(sessionNameFor(s1.id), 'claude');
    tmux.addSession(sessionNameFor(s2.id), 'bash'); // 用户 /exit 或崩溃后的真实状态
    tmux.addSession(sessionNameFor(s3.id), 'claude');

    const ok = await mgr.applyModel(e, 'claude-3-5-sonnet');
    assert.strictEqual(ok, true, 'skip 不是失败，整体应返回 true');

    // 只有两个 claude 槽收到了 /model；bash 槽一条命令都没收到。
    const sentTo = tmux.sentLiterals.map((x) => x.session).sort();
    assert.deepStrictEqual(sentTo.sort(), [sessionNameFor(s1.id), sessionNameFor(s3.id)].sort());
    assert.ok(tmux.sentLiterals.every((x) => x.text === '/model claude-3-5-sonnet'));
    assert.ok(!tmux.sentEnters.includes(sessionNameFor(s2.id)));

    // 配置照常落盘（部分成功也要落盘，跳过的槽下次启动自然带上新模型）。
    const [reloaded] = await store.load();
    assert.strictEqual(reloaded.model, 'claude-3-5-sonnet');

    // 没有被 refuse（那是「全部不合格」才走的分支）。
    assert.strictEqual(errorMsgs().length, 0);

    // 汇报点名了「第 2 个会话」被跳过，原因是未在跑 claude —— 不能只报条目名。
    const info = infoMsgs();
    assert.strictEqual(info.length, 1);
    assert.match(info[0], /第 2 个会话/);
    assert.match(info[0], /未在跑 claude/);
    assert.match(info[0], /测试终端/);
  });

  it('全部存活槽都不是 claude：等价于没有 claude 在跑，直接落配置、下次启动生效', async () => {
    const { mgr, tmux, store } = setup();
    const s1 = slot({ order: 0 });
    const s2 = slot({ order: 1 });
    const e = entry([s1, s2]);
    await store.add(e);

    tmux.addSession(sessionNameFor(s1.id), 'bash');
    tmux.addSession(sessionNameFor(s2.id), 'zsh');

    const ok = await mgr.applyModel(e, 'claude-3-5-sonnet');
    assert.strictEqual(ok, true, '一个健康槽都没有——跟会话压根不存在同侧处理，不再整体拒绝');

    assert.strictEqual(tmux.sentLiterals.length, 0, '没有 claude 在跑，不应该给任何槽发送命令');

    const [reloaded] = await store.load();
    assert.strictEqual(reloaded.model, 'claude-3-5-sonnet', '纯配置变更，照常落盘');

    assert.strictEqual(errorMsgs().length, 0, '不再是拒绝，不应该有错误提示');
    const info = infoMsgs();
    assert.strictEqual(info.length, 1);
    assert.match(info[0], /第 1 个会话/);
    assert.match(info[0], /第 2 个会话/);
    assert.match(info[0], /未在跑 claude/);
    assert.match(info[0], /下次启动生效/);
  });

  it('全部存活槽都是 claude：照常全部处理，不产生「跳过」提示', async () => {
    const { mgr, tmux, store } = setup();
    const s1 = slot({ order: 0 });
    const s2 = slot({ order: 1 });
    const e = entry([s1, s2]);
    await store.add(e);

    tmux.addSession(sessionNameFor(s1.id), 'claude');
    tmux.addSession(sessionNameFor(s2.id), 'claude');

    const ok = await mgr.applyModel(e, 'claude-3-5-sonnet');
    assert.strictEqual(ok, true);
    assert.strictEqual(tmux.sentLiterals.length, 2);
    assert.strictEqual(infoMsgs().length, 0, '全部健康时不应该弹「跳过」提示');
    assert.strictEqual(errorMsgs().length, 0);
  });
});

describe('TerminalManager.applyProfile —— 部分槽跳过、不再全有全无', () => {
  beforeEach(() => resetVscodeMock());

  it('2 个存活槽、1 个已退回 bash：跳过它，只重启健康槽，配置照常落盘', async () => {
    const { mgr, tmux, store } = setup();
    const s1 = slot({ order: 0, conversationId: 'conv-1' }); // 健康、已绑定
    const s2 = slot({ order: 1 }); // bash，未绑定也无所谓——它会被跳过，不会走到重启
    const e = entry([s1, s2], { profile: 'ccr' });
    await store.add(e);

    tmux.addSession(sessionNameFor(s1.id), 'claude');
    tmux.addSession(sessionNameFor(s2.id), 'bash');

    const ok = await mgr.applyProfile(e, 'direct');
    assert.strictEqual(ok, true);

    // s1 被重启：发了 /exit + 回车，随后发了 --resume 对应的命令。
    const s1Session = sessionNameFor(s1.id);
    const s1Texts = tmux.sentLiterals.filter((x) => x.session === s1Session).map((x) => x.text);
    assert.strictEqual(s1Texts[0], '/exit');
    assert.ok(s1Texts.length >= 2, '/exit 之后还应该发接回对话的命令');

    // s2（bash）完全没被触碰。
    const s2Session = sessionNameFor(s2.id);
    assert.strictEqual(tmux.sentLiterals.filter((x) => x.session === s2Session).length, 0);

    const [reloaded] = await store.load();
    assert.strictEqual(reloaded.profile, 'direct');
    assert.strictEqual(reloaded.model, undefined);

    assert.strictEqual(errorMsgs().length, 0);
    const info = infoMsgs();
    assert.strictEqual(info.length, 1);
    assert.match(info[0], /第 2 个会话/);
    assert.match(info[0], /未在跑 claude/);
  });

  it('全部存活槽都不是 claude：等价于没有 claude 在跑，直接落配置、下次启动生效', async () => {
    const { mgr, tmux, store } = setup();
    const s1 = slot({ order: 0, conversationId: 'conv-1' });
    const e = entry([s1], { profile: 'ccr' });
    await store.add(e);

    tmux.addSession(sessionNameFor(s1.id), 'bash');

    const ok = await mgr.applyProfile(e, 'direct');
    assert.strictEqual(ok, true, '一个健康槽都没有——跟会话压根不存在同侧处理，不再整体拒绝');

    assert.strictEqual(tmux.sentLiterals.length, 0, '没有 claude 在跑，不应该给任何槽发送命令（不会走到重启）');

    const [reloaded] = await store.load();
    assert.strictEqual(reloaded.profile, 'direct', '纯配置变更，照常落盘');
    assert.strictEqual(reloaded.model, undefined);

    assert.strictEqual(errorMsgs().length, 0, '不再是拒绝，不应该有错误提示');
    const info = infoMsgs();
    assert.strictEqual(info.length, 1);
    assert.match(info[0], /第 1 个会话/);
    assert.match(info[0], /未在跑 claude/);
    assert.match(info[0], /下次启动生效/);
  });

  it('健康槽本身重启失败（未绑定对话）：这是真失败，不是跳过 —— 整体不落配置', async () => {
    const { mgr, tmux, store } = setup();
    const s1 = slot({ order: 0 }); // bash，会被跳过
    const s2 = slot({ order: 1 }); // claude 但没有 conversationId —— restartClaude 会拒绝重启
    const e = entry([s1, s2], { profile: 'ccr' });
    await store.add(e);

    tmux.addSession(sessionNameFor(s1.id), 'bash');
    tmux.addSession(sessionNameFor(s2.id), 'claude');

    const ok = await mgr.applyProfile(e, 'direct');
    assert.strictEqual(ok, false, '真正尝试重启的健康槽自己失败了，必须整体判失败');

    // s2 从未被送过任何命令（restartClaude 在发 /exit 之前就因为未绑定而拒绝）。
    assert.strictEqual(tmux.sentLiterals.filter((x) => x.session === sessionNameFor(s2.id)).length, 0);

    const [reloaded] = await store.load();
    assert.strictEqual(reloaded.profile, 'ccr', '中途失败不落配置——即便另一个槽只是被跳过');

    // 应该看到「未绑定对话」的错误，而不是被误报成「跳过」。
    const errs = errorMsgs();
    assert.ok(errs.some((m) => /还没有绑定对话/.test(m)));
    // 不应该出现「已切换成功、跳过 N 个」这种误导性的 info 提示。
    assert.strictEqual(infoMsgs().length, 0);
  });

  it('profile 未变化：直接返回 true，不碰任何槽', async () => {
    const { mgr, tmux, store } = setup();
    const s1 = slot({ order: 0 });
    const e = entry([s1], { profile: 'ccr' });
    await store.add(e);
    tmux.addSession(sessionNameFor(s1.id), 'claude');

    const ok = await mgr.applyProfile(e, 'ccr');
    assert.strictEqual(ok, true);
    assert.strictEqual(tmux.sentLiterals.length, 0);
  });
});
