import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  LineSplitter,
  PreviewMessage,
  TranscriptReader,
  parseTranscript,
  parseTranscriptLine,
} from '../../src/core/transcript';

const line = (o: object) => JSON.stringify(o);

const USER_LINE = (content: unknown) =>
  line({ type: 'user', userType: 'external', isSidechain: false, message: { role: 'user', content } });

const ASSISTANT_LINE = (content: unknown) =>
  line({ type: 'assistant', message: { role: 'assistant', content } });

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'tmuxterm-transcript-'));

/** 写一串行到临时文件，返回路径。 */
async function writeLines(lines: string[]): Promise<string> {
  const dir = await tmpDir();
  const file = path.join(dir, 'session.jsonl');
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

describe('parseTranscriptLine —— 单行 .jsonl → 正文消息', () => {
  it('user 字符串消息被取出', () => {
    assert.deepStrictEqual(parseTranscriptLine(USER_LINE('帮我看下这个 bug')), {
      role: 'user',
      text: '帮我看下这个 bug',
    });
  });

  it('user 数组里纯 tool_result → 不产消息', () => {
    const l = USER_LINE([{ type: 'tool_result', tool_use_id: 'x', content: '回执' }]);
    assert.strictEqual(parseTranscriptLine(l), undefined);
  });

  it('assistant 只拼 text 块，thinking / tool_use 被丢弃', () => {
    const l = ASSISTANT_LINE([
      { type: 'thinking', thinking: '内部推理' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
    ]);
    assert.deepStrictEqual(parseTranscriptLine(l), {
      role: 'assistant',
      text: '第一段\n\n第二段',
    });
  });

  it('isSidechain: true 被丢弃（子代理不是正文）', () => {
    const l = line({
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: '子代理说的话' },
    });
    assert.strictEqual(parseTranscriptLine(l), undefined);
  });

  it('isMeta: true 被丢弃', () => {
    const l = line({ type: 'user', isMeta: true, message: { role: 'user', content: '元数据' } });
    assert.strictEqual(parseTranscriptLine(l), undefined);
  });

  it('<task-notification> 包裹的 user 消息被丢弃', () => {
    const l = USER_LINE('<task-notification>子代理已完成</task-notification>');
    assert.strictEqual(parseTranscriptLine(l), undefined);
  });

  it('compaction 摘要被丢弃（开头是续接说明，不是用户敲的）', () => {
    const l = USER_LINE(
      'This session is being continued from a previous conversation that ran out of context. ' +
        'The summary is as follows: ...',
    );
    assert.strictEqual(parseTranscriptLine(l), undefined);
  });

  it('斜杠命令的合成消息还原成用户实际敲的那一行', () => {
    const l = USER_LINE(
      '<command-name>/drive-fix</command-name>\n' +
        '<command-message>drive-fix</command-message>\n' +
        '<command-args>123</command-args>',
    );
    assert.deepStrictEqual(parseTranscriptLine(l), { role: 'user', text: '/drive-fix 123' });
  });

  it('/clear 命令 → 不产消息（它不是任务内容）', () => {
    const l = USER_LINE(
      '<command-name>/clear</command-name>\n' +
        '<command-message>clear</command-message>\n' +
        '<command-args></command-args>',
    );
    assert.strictEqual(parseTranscriptLine(l), undefined);
  });

  it('坏 JSON 行被跳过，且不影响后面的行', () => {
    const messages: PreviewMessage[] = [];
    for (const l of ['{"type":"user","message":{"conten', USER_LINE('后面的正常消息')]) {
      const m = parseTranscriptLine(l);
      if (m !== undefined) messages.push(m);
    }
    assert.deepStrictEqual(messages, [{ role: 'user', text: '后面的正常消息' }]);
  });
});

describe('parseTranscript —— 整段多行', () => {
  it('顺序与数量正确，无关记录被丢掉', () => {
    const text = [
      line({ type: 'mode', sessionId: 'x' }),
      line({ type: 'attachment', attachment: {} }),
      USER_LINE('第一句'),
      ASSISTANT_LINE([{ type: 'text', text: '答一句' }]),
      line({ type: 'ai-title', aiTitle: '标题' }),
      USER_LINE('第二句'),
    ].join('\n');

    assert.deepStrictEqual(parseTranscript(text), [
      { role: 'user', text: '第一句' },
      { role: 'assistant', text: '答一句' },
      { role: 'user', text: '第二句' },
    ]);
  });
});

describe('LineSplitter —— 按字节切行，不破坏多字节字符', () => {
  it('★ 在中文字符中间切开、分两次 push，仍得到完整两行且无 U+FFFD', () => {
    const splitter = new LineSplitter();
    const buf = Buffer.from('你好\n世界\n', 'utf8');
    // 切在「你」的 UTF-8 字节中间（「你」= e4 bd a0）
    const first = splitter.push(buf.subarray(0, 2));
    const second = splitter.push(buf.subarray(2));

    assert.deepStrictEqual(first, [], '第一段还没有完整的行');
    assert.deepStrictEqual(second, ['你好', '世界']);
    assert.ok(!second.join('').includes('�'), '不该出现替换字符');
  });

  it('末尾无换行的半行不返回，补上换行后才返回', () => {
    const splitter = new LineSplitter();
    assert.deepStrictEqual(splitter.push(Buffer.from('半行', 'utf8')), []);
    assert.deepStrictEqual(splitter.push(Buffer.from('\n', 'utf8')), ['半行']);
  });
});

describe('TranscriptReader —— 增量读取', () => {
  it('先读两行，再追加一行只返回新增的那条', async () => {
    const file = await writeLines([USER_LINE('第一条'), USER_LINE('第二条')]);
    const reader = new TranscriptReader();

    const first = await reader.readNew(file);
    assert.strictEqual(first.reset, false);
    assert.deepStrictEqual(first.messages.map((m) => m.text), ['第一条', '第二条']);

    await fs.appendFile(file, USER_LINE('第三条') + '\n', 'utf8');
    const second = await reader.readNew(file);
    assert.strictEqual(second.reset, false);
    assert.deepStrictEqual(second.messages.map((m) => m.text), ['第三条']);
  });

  it('★ 读完后再截断重写 → reset === true，消息来自新内容', async () => {
    const file = await writeLines([USER_LINE('旧内容一'), USER_LINE('旧内容二')]);
    const reader = new TranscriptReader();
    await reader.readNew(file);

    await fs.writeFile(file, USER_LINE('新内容') + '\n', 'utf8');
    const again = await reader.readNew(file);

    assert.strictEqual(again.reset, true);
    assert.deepStrictEqual(again.messages.map((m) => m.text), ['新内容']);
  });
});
