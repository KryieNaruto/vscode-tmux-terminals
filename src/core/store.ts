import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isV1Shape, migrateEntry } from './migrate';
import { TerminalEntry } from './types';

/** 生成条目 id。用 crypto 而非 Math.random，避免同一毫秒内碰撞。 */
export function newId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export class EntryStore {
  constructor(private readonly filePath: string) {}

  /** 读原始 JSON，宽容失败。返回 undefined 表示文件不存在或不是数组。 */
  private async readRaw(): Promise<unknown[] | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 载入条目。
   *
   * **迁移即校验：没有单独的过滤阶段。** migrateEntry 是唯一的守门人 ——
   * 它把 v1 条目迁移到 v2、把损坏/缺字段的条目判为不可迁移（返回
   * undefined，此处丢弃）。正因如此，「先迁移后过滤」的顺序在这里
   * **不可能被写错**：根本没有一个能在迁移之前跑掉的过滤器。
   *
   * 若未来有人把校验单独抽出来（例如一个只认 v2 形态的过滤器）并放到
   * 迁移之前，v1 的条目会被全部静默丢弃（远端实测 6 条）——那正是本任务
   * 要防的数据丢失。
   *
   * 读取不改写文件 —— 迁移结果只存在于内存，等用户下次真实改动时才落盘。
   * 「打开个扩展就改了用户文件」是不可接受的副作用。
   */
  async load(): Promise<TerminalEntry[]> {
    const raw = await this.readRaw();
    if (raw === undefined) return [];
    const migrated: TerminalEntry[] = [];
    raw.forEach((item, i) => {
      const m = migrateEntry(item, i);
      if (m !== undefined) migrated.push(m);
    });
    // 按 order 升序；order 相同时保持原下标顺序（稳定排序）
    return migrated
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (a.e.order - b.e.order) || (a.i - b.i))
      .map((x) => x.e);
  }

  /**
   * 若文件是 v1 形态，备份为 `<file>.bak` 并返回 true。
   *
   * 只在真的要迁移时备份，且**已存在的备份不覆盖** —— 第一次的备份才是
   * 用户的原始数据，后续覆盖会让它失去意义。
   */
  async migrateAndBackup(): Promise<boolean> {
    const raw = await this.readRaw();
    if (raw === undefined) return false;
    if (!raw.some(isV1Shape)) return false;
    const bak = `${this.filePath}.bak`;
    try {
      await fs.access(bak);
      return false; // 已有备份，不覆盖
    } catch {
      // 不存在 → 建它
    }
    const text = await fs.readFile(this.filePath, 'utf8');
    await fs.writeFile(bak, text, 'utf8');
    return true;
  }

  async save(entries: TerminalEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // 临时名必须每次唯一。曾用固定的 `filePath + '.tmp'`，两次 save 交错时
    // 先完成者把 .tmp rename 走，后完成者 rename 时源已不存在 → ENOENT。
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * 串行化「读-改-写」。
   *
   * `add` / `append` / `update` / `remove` / `reorder` 都是 load→修改→save
   * 的复合操作。并发调用时两次 load 会读到同一份旧数据，后写的覆盖先写的，
   * 造成丢更新（实测两次并发 add 只留下 1 条）。所有写操作在此排队。
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(op, op);
    this.writeChain = next.catch(() => {});
    return next;
  }

  async add(entry: TerminalEntry): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      all.push(entry);
      await this.save(all);
    });
  }

  /**
   * 追加一条新条目，**order 在锁内分配**。
   *
   * 不能在调用方算 order：`load` 与 `append` 之间没有锁，两次并发新增会
   * 算出同一个 order，排序随即变得不确定。也不能让调用方传 0 —— 那样每条
   * 新条目的 order 都相同。
   */
  async append(entry: Omit<TerminalEntry, 'order'>): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      const next = all.reduce((m, e) => Math.max(m, e.order), -1) + 1;
      all.push({ ...entry, order: next });
      await this.save(all);
    });
  }

  async update(id: string, patch: Partial<TerminalEntry>): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      const idx = all.findIndex((e) => e.id === id);
      if (idx === -1) return;
      all[idx] = { ...all[idx], ...patch, id: all[idx].id };
      await this.save(all);
    });
  }

  async remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      await this.save(all.filter((e) => e.id !== id));
    });
  }

  /**
   * 按给定 id 顺序重排，并把 order 重编号为 0..n-1。
   *
   * 重编号而非累加：连续拖拽会让 order 无限增长，且容易出现相等值。
   * 未出现在 ids 里的条目追加在末尾（防御：调用方的列表可能已过期）。
   */
  async reorder(idsInNewOrder: string[]): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      const byId = new Map(all.map((e) => [e.id, e]));
      const reordered: TerminalEntry[] = [];
      for (const id of idsInNewOrder) {
        const e = byId.get(id);
        if (e !== undefined) {
          reordered.push(e);
          byId.delete(id);
        }
      }
      reordered.push(...byId.values());
      await this.save(reordered.map((e, i) => ({ ...e, order: i })));
    });
  }

  async findByName(name: string): Promise<TerminalEntry | undefined> {
    const all = await this.load();
    return all.find((e) => e.name === name);
  }
}
