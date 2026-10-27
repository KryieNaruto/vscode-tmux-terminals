/**
 * 「transcript 的 .jsonl → 预览面板要显示的正文消息」的纯逻辑。
 *
 * 本文件同样不依赖 vscode：只碰 Node 的 fs/promises 与 Buffer，便于直接单测。
 *
 * 为什么要过滤，而不是原样显示：
 * - `.jsonl` 里一行是一条**记录**，混着 mode / snapshot / attachment / ai-title
 *   这些跟「谁说了什么」无关的东西；
 * - user 行里有一大半不是用户敲的：tool_result 是工具回执、isSidechain 是子代理、
 *   isMeta 是元数据、`<task-notification>` / `<system-reminder>` 是注入、
 *   compaction 摘要是 claude 自己写的续接内容；
 * - assistant 行里 thinking / tool_use 是过程，面板要的是正文。
 *
 * 所以只保留「用户真正说的一行」和「Claude 的正文回复」两类，其余一律丢弃。
 * 容错是契约：坏行、被截断的行绝不抛错，跳过即可 —— 面板宁可少一条，不能崩。
 */

import * as fs from 'fs/promises';
import { commandEcho, isSyntheticUserText } from './conversation';

/** 面板上的一条正文消息。 */
export interface PreviewMessage {
  role: 'user' | 'assistant';
  /** 原始 markdown 文本（尚未渲染） */
  text: string;
}

/** 单行超过这个字节数直接丢弃：几乎必然是内嵌图片或超大 tool_result，解析只会白烧内存。 */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;

/**
 * 把 `push` 进来的字节流切成一整行一整行的文本。
 *
 * **必须用 Buffer 保存尾巴，绝不能先 toString() 再按字符串拼**：一个多字节
 * UTF-8 字符完全可能跨两次读取边界，按字符串切会在边界处产出 U+FFFD（`�`），
 * 而且无法还原。Buffer 里存的是原始字节，拼完整了再解码才是安全的。
 */
export class LineSplitter {
  /** 尚未遇到 `\n` 的尾巴（原始字节）。 */
  private carry: Buffer = Buffer.alloc(0);

  /** 喂一段字节，返回其中**已经完整**的行（不含换行符）。 */
  push(chunk: Buffer): string[] {
    this.carry = Buffer.concat([this.carry, chunk]);
    const parts: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.carry.indexOf(0x0A, start);
      if (nl < 0) break;
      parts.push(this.carry.subarray(start, nl).toString('utf8'));
      start = nl + 1;
    }
    this.carry = this.carry.subarray(start);
    return parts;
  }

  reset(): void {
    this.carry = Buffer.alloc(0);
  }
}

/** 从 content 数组里把 text 块拼起来（用空行分隔），空的返回 undefined。 */
function joinTextBlocks(content: readonly unknown[]): string | undefined {
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
  }
  if (texts.length === 0) return undefined;
  const text = texts.join('\n\n').trim();
  return text.length === 0 ? undefined : text;
}

/**
 * 解析一行 jsonl。不是「用户/Claude 的正文」就返回 undefined。
 *
 * 先按字节长度挡超长行：`length` 是字符数，不是字节数，用它会把一条 1 MB 的
 * 中文行放进来（占 3 MB 内存再解析）。
 */
export function parseTranscriptLine(line: string): PreviewMessage | undefined {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return undefined;

  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined; // 坏行 / 被截断的行
  }
  if (typeof o !== 'object' || o === null) return undefined;
  const rec = o as Record<string, unknown>;

  // 子代理与元数据都不是用户 / Claude 的正文
  if (rec.isSidechain === true || rec.isMeta === true) return undefined;

  const msg = rec.message as { content?: unknown } | undefined;
  const content = msg === undefined ? undefined : msg.content;

  if (rec.type === 'user') {
    if (typeof content === 'string') {
      // 斜杠命令要先还原成用户实际敲的那一行，否则它会被 isSyntheticUserText 丢掉
      const echo = commandEcho(content);
      if (echo !== undefined) return { role: 'user', text: echo };
      if (isSyntheticUserText(content)) return undefined;
      const text = content.trim();
      return text.length === 0 ? undefined : { role: 'user', text };
    }
    if (Array.isArray(content)) {
      // 只取 text 块：tool_result 是工具回执，自然被丢弃
      const text = joinTextBlocks(content);
      return text === undefined ? undefined : { role: 'user', text };
    }
    return undefined;
  }

  if (rec.type === 'assistant') {
    // thinking / tool_use 块一律跳过，只拼 text
    if (!Array.isArray(content)) return undefined;
    const text = joinTextBlocks(content);
    return text === undefined ? undefined : { role: 'assistant', text };
  }

  return undefined;
}

/** 整段文本逐行解析（首读与单测用）。 */
export function parseTranscript(text: string): PreviewMessage[] {
  const messages: PreviewMessage[] = [];
  for (const line of text.split('\n')) {
    const m = parseTranscriptLine(line);
    if (m !== undefined) messages.push(m);
  }
  return messages;
}

/**
 * 增量读取一个 transcript 文件。
 *
 * 每次 `readNew(file)` 从上次读到的字节偏移继续，只解析新追加的部分。文件名
 * 由调用方每次传入、不存字段 —— 面板切换目标时会换文件。
 *
 * 一旦发现「文件被截断」或「换成了另一个文件（inode 变了）」，就从头重读。
 * 注意**先 reset 再记录 ino**：reset 会把 ino 清成 undefined，顺序反了会丢掉
 * 本次的 inode，下次换文件就判不出来。
 */
export class TranscriptReader {
  /** 已消费到的字节偏移；0 表示还没读过 */
  private offset = 0;
  private ino: number | undefined;
  private splitter = new LineSplitter();

  async readNew(file: string): Promise<{ messages: PreviewMessage[]; reset: boolean }> {
    const fh = await fs.open(file, 'r');
    try {
      const st = await fh.stat();

      let reset = false;
      if (st.size < this.offset || (this.ino !== undefined && st.ino !== this.ino)) {
        this.reset();
        reset = true;
      }
      this.ino = st.ino;

      const CHUNK = 1024 * 1024;
      const messages: PreviewMessage[] = [];
      while (this.offset < st.size) {
        const len = Math.min(CHUNK, st.size - this.offset);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.offset);
        if (bytesRead <= 0) break; // 防御：文件在缩，别死循环
        this.offset += bytesRead;
        for (const line of this.splitter.push(buf.subarray(0, bytesRead))) {
          const m = parseTranscriptLine(line);
          if (m !== undefined) messages.push(m);
        }
      }
      return { messages, reset };
    } finally {
      await fh.close();
    }
  }

  reset(): void {
    this.offset = 0;
    this.ino = undefined;
    this.splitter.reset();
  }

  /** 当前已读到的字节偏移（供测试断言） */
  get position(): number {
    return this.offset;
  }
}
