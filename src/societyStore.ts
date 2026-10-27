import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Society } from './core/society';

/**
 * `society.json` 的持久化：一个 `Society[]` 数组。
 *
 * 写入方式与 EntryStore（core/store.ts）同源：**tmp 唯一名 + rename** 的原子写，
 * `JSON.stringify(x, null, 2)`，损坏文件在被覆盖前另存为 `<file>.corrupt`。
 *
 * 与 EntryStore 唯一的差别是**同步**：本类的接口按约定是同步的（`load(): Society[]`），
 * 因此用 `fs` 的同步函数而不是 `fs/promises`。同步也顺带免掉了 EntryStore 里那条
 * `writeChain`：JavaScript 单线程，一个同步的「读-改-写」中间不可能被别的调用插入。
 */
export class SocietyStore {
  constructor(
    private readonly filePath: string,
    /**
     * 文件存在但不可用（解析失败 / 合法 JSON 但不是数组）、已另存为
     * `<file>.corrupt` 时回调，携带原始错误。宿主据此提示用户 ——
     * 本层不依赖 vscode。只在**真的写出**恢复文件时回调一次：已有 `.corrupt`
     * 说明用户的原始数据早就保住了，每次 load 都提示只会变成噪声。
     */
    private readonly onCorrupt?: (err: unknown) => void,
  ) {}

  /**
   * 读 society 数组。
   *
   * 文件不存在 / 读不到 / 内容不可用，一律返回 `[]`（与 EntryStore.readRaw 的
   * 宽容一致）。后两种情况下，只要原文里还有字节，就先另存为 `<file>.corrupt`
   * —— 否则紧接着的一次 add/remove 就会用一份新数组把它盖掉。
   */
  load(): Society[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return []; // 不存在（或读不到）→ 正常的空启动，无需保护
    }
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Society[];
      // JSON 合法却不是数组：同样是损坏，但拿不到一个解析错误，给个说得清的。
      this.preserveIfCorrupt(raw, new Error(`${this.filePath} 的内容不是 Society[]`));
    } catch (err) {
      this.preserveIfCorrupt(raw, err);
    }
    return [];
  }

  /**
   * 把原文另存为 `<file>.corrupt`。已存在的**不覆盖** —— 第一份才是用户的原始数据。
   *
   * 同样用 tmp + rename：中途崩溃不能留下半份「恢复文件」冒充原文。
   */
  private preserveIfCorrupt(raw: string, err: unknown): void {
    const corrupt = `${this.filePath}.corrupt`;
    try {
      fs.accessSync(corrupt);
      return; // 已有恢复文件，不覆盖、也不再提示
    } catch {
      // 不存在 → 建它
    }
    const tmp = `${corrupt}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, raw, 'utf8');
      fs.renameSync(tmp, corrupt);
    } catch (writeErr) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 清临时文件失败不能盖掉真正要报的错
      }
      this.onCorrupt?.(writeErr);
      return;
    }
    this.onCorrupt?.(err);
  }

  /**
   * 原子写。临时名每次唯一：固定的 `<file>.tmp` 在两次写交错时会 ENOENT
   * （先完成者已把它 rename 走），这是 EntryStore.save 注释里踩过的坑。
   */
  private save(societies: Society[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(societies, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 同上：不掩盖原始错误
      }
      throw err;
    }
  }

  add(s: Society): void {
    const all = this.load();
    all.push(s);
    this.save(all);
  }

  /** 按 id 替换。id 不存在时什么都不做（幂等，调用方可能拿着过期数据）。 */
  update(s: Society): void {
    const all = this.load();
    const idx = all.findIndex((x) => x.id === s.id);
    if (idx === -1) return;
    // id 钉死在原值（照 EntryStore.update 的做法）：补丁里混进别的 id
    // 等于换了一个 society，而调用方以为自己在改它。
    all[idx] = { ...s, id: all[idx].id };
    this.save(all);
  }

  remove(id: string): void {
    const all = this.load();
    this.save(all.filter((s) => s.id !== id));
  }

  findById(id: string): Society | undefined {
    return this.load().find((s) => s.id === id);
  }
}
