import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TerminalEntry } from './types';

/** 生成条目 id。用 crypto 而非 Math.random，避免同一毫秒内碰撞。 */
export function newId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * 条目清单的持久化。
 *
 * 写入走「写临时文件 → rename」：rename 在同一文件系统内是原子的，
 * 避免进程在写一半时被杀导致清单变成半个 JSON。
 *
 * 读取对损坏内容一律宽容（返回空数组），因为清单损坏不该让扩展
 * 整个激活失败 —— 用户还能重新添加条目。
 */
export class EntryStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<TerminalEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isEntry);
    } catch {
      return [];
    }
  }

  async save(entries: TerminalEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }

  async add(entry: TerminalEntry): Promise<void> {
    const all = await this.load();
    all.push(entry);
    await this.save(all);
  }

  async update(id: string, patch: Partial<TerminalEntry>): Promise<void> {
    const all = await this.load();
    const idx = all.findIndex((e) => e.id === id);
    if (idx === -1) return;
    all[idx] = { ...all[idx], ...patch, id: all[idx].id };
    await this.save(all);
  }

  async remove(id: string): Promise<void> {
    const all = await this.load();
    await this.save(all.filter((e) => e.id !== id));
  }

  async findByName(name: string): Promise<TerminalEntry | undefined> {
    const all = await this.load();
    return all.find((e) => e.name === name);
  }
}

function isEntry(v: unknown): v is TerminalEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.cwd === 'string' &&
    Array.isArray(o.commands) &&
    o.commands.every((c) => typeof c === 'string') &&
    typeof o.autoRestore === 'boolean'
  );
}
