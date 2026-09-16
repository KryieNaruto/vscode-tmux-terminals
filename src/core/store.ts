import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isV1Shape, isV2Shape, migrateEntry } from './migrate';
import { nextSessionOrder, sortSessions } from './sessions';
import { SessionSlot, TerminalEntry } from './types';

/** 生成条目 id。用 crypto 而非 Math.random，避免同一毫秒内碰撞。 */
export function newId(): string {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * 生成一条新对话的 id（UUID v4）。
 *
 * 必须是**真 UUID**：它既是 `claude --session-id` 的参数，也会成为
 * `~/.claude/projects/<目录>/<uuid>.jsonl` 的文件名，还是 `--resume` 的
 * 唯一凭据。所以用 crypto.randomUUID 而不是自己拼，避免格式不符。
 */
export function newConversationId(): string {
  return crypto.randomUUID();
}

export class EntryStore {
  constructor(
    private readonly filePath: string,
    /**
     * 文件「存在但不可用」、已在被覆盖前另存为 `<file>.corrupt` 时回调。
     * 宿主（extension.ts）据此提示用户 —— core 层不依赖 vscode。
     */
    private readonly onCorrupt?: (corruptPath: string) => void,
  ) {}

  /**
   * 若目标文件**存在但不是一份可用的条目数组**（解析失败，或 JSON 合法却
   * 不是数组），在它被覆盖之前，把原文原子地另存为 `<file>.corrupt`。
   *
   * 为什么：readRaw 把「不存在」「读不到」「存在但不可用」一律当成
   * undefined，load() 随即返回 []；此时任何一次写入都会用一份新数组盖掉
   * 用户的原始数据。而 `.bak` 只在 v1 迁移时生成，损坏场景下根本没有备份
   * —— 本分支在**读路径**上拼命保住用户的 6 条条目，写路径却没有对称的
   * 保护，一次 append 就能把 `{oooo` 变成一条空清单。
   *
   * 已存在的 `.corrupt` 不覆盖：第一份才是用户的原始数据。
   * 返回 true 表示本次真的写出了恢复文件（供宿主提示一次）。
   */
  private async preserveIfCorrupt(): Promise<boolean> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return false; // 不存在（或读不到）→ 正常的空启动，无需保护
    }
    try {
      if (Array.isArray(JSON.parse(text))) return false; // 可用 → 无需保护
    } catch {
      // 解析失败 → 落到下面，按损坏处理
    }
    const corrupt = `${this.filePath}.corrupt`;
    try {
      await fs.access(corrupt);
      return false; // 已有恢复文件，不覆盖
    } catch {
      // 不存在 → 建它
    }
    // 原子写：先写唯一临时名再 rename，避免中途崩溃留下半份恢复文件
    const tmp = `${corrupt}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, corrupt);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return true;
  }

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
    // 按 order 升序；order 相同时保持原下标顺序（稳定排序）。
    // 负数 order 只可能来自手改文件（spec 规定从 0 递增），钳到 0 —— 否则
    // 一个 -1 会永远排在最前，而后续写入又会把它重编号，状态自相矛盾。
    return (
      migrated
        .map((e, i) => ({ e: { ...e, order: Math.max(0, e.order) }, i }))
        .sort((a, b) => (a.e.order - b.e.order) || (a.i - b.i))
        // 槽也各自归一化一次（按 order 升序 + 负数钳零）。**放在这里而不是各
        // 消费方**：tree / batchTree / terminalManager 拿到的 `sessions` 必须已经
        // 是「排好序、无负数」的同一份真相，各算一遍迟早会算歪。与条目排序一样，
        // 这一步**不改写文件** —— 迁移与归一化只存在于内存。
        .map((x) => ({ ...x.e, sessions: sortSessions(x.e.sessions) }))
    );
  }

  /**
   * 若文件是 v1 形态，备份为 `<file>.bak` 并返回 true。
   *
   * 只在真的要迁移时备份，且**已存在的备份不覆盖** —— 第一次的备份才是
   * 用户的原始数据，后续覆盖会让它失去意义。
   *
   * 注意备份名 `<file>.bak` **不带版本号**：将来若出现 v3 迁移，它必须改用
   * 带版本的后缀（如 `.v2.bak`），否则 v3 的迁移会撞上这里"备份已存在"的
   * 判断而静默跳过，让更晚（更接近现状）的那份状态失去保护。
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

  /**
   * 若文件里含 v2 形态的条目，备份为 `<file>.v2.bak` 并返回 true。
   *
   * 与上面 `migrateAndBackup`（v1 → `<file>.bak`）**并列、互不覆盖**。三种输入
   * 因此各得其所：v1 文件只写 `.bak`（里面是 v1 原文），v2 文件只写 `.v2.bak`
   * （里面是 v2 原文），v3 文件一个都不写 —— 两个备份名各自都是诚实的，不会
   * 出现「叫 `.v2.bak` 里面却是 v1」。
   *
   * 两条规则与 v1 那份完全同源：**只在真的要迁移时**才写（判据是 isV2Shape，
   * 而不是「有 profile」—— 见 migrate.ts 里那条注释），且**已存在的不覆盖**
   * ——第一次的备份才是用户的原始数据，覆盖会让它失去意义。
   */
  async migrateAndBackupV2(): Promise<boolean> {
    const raw = await this.readRaw();
    if (raw === undefined) return false;
    if (!raw.some(isV2Shape)) return false;
    const bak = `${this.filePath}.v2.bak`;
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
    // 覆盖之前先抢救。所有写路径（add/append/update/remove/reorder）都汇到
    // 这里，是唯一需要守卫的咽喉 —— 放到 readRaw 里太早（读不动写时才知道
    // 要不要保），放到各写方法里又会漏。
    if (await this.preserveIfCorrupt()) {
      this.onCorrupt?.(`${this.filePath}.corrupt`);
    }
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

  /**
   * 在锁内定位槽并合并补丁。条目 / 槽不存在则什么都不做。
   *
   * **为什么必须新增而不是复用 `update`**：`update(id, patch)` 的 patch 是调用方
   * 在**锁外**算好的。槽级改动在锁外算，就会「load 出旧数组 → 改一个槽 → 写回」
   * —— 同一终端的两个槽在同一轮 reconcile 里各自算出新数组时，后写者盖掉先写者
   * （lost update），表现为「改绑偶尔不生效」。这与 `append` 注释里「order 不能
   * 在调用方算」是**同一类**错误，用同一种办法（把复合操作收进锁内）解决。
   *
   * `id` 钉死在原值（照 `update` 对 `entry.id` 的做法）：补丁里混进 `id` 就会把
   * 槽的 tmux 会话名改掉 —— 那等于换了一个会话，而调用方以为自己只是在改绑定。
   */
  async updateSession(
    entryId: string,
    sessionId: string,
    patch: Partial<SessionSlot>,
  ): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      const idx = all.findIndex((e) => e.id === entryId);
      if (idx === -1) return;
      const entry = all[idx];
      if (!entry.sessions.some((s) => s.id === sessionId)) return;
      all[idx] = {
        ...entry,
        sessions: entry.sessions.map(
          (s) => (s.id === sessionId ? { ...s, ...patch, id: s.id } : s),
        ),
      };
      await this.save(all);
    });
  }

  /**
   * 在锁内追加一个槽，`order` **在锁内分配**（理由同 `append`：在调用方算的话，
   * `load` 与写入之间没有锁，两次并发新增会算出同一个 order，排序随即变得不确定）。
   *
   * 入参因此是 `Omit<SessionSlot, 'order'>` —— 调用方只需要给 id（和可选的绑定），
   * order 由这里补齐。
   */
  async addSession(entryId: string, slot: Omit<SessionSlot, 'order'>): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      const idx = all.findIndex((e) => e.id === entryId);
      if (idx === -1) return;
      const entry = all[idx];
      all[idx] = {
        ...entry,
        sessions: [...entry.sessions, { ...slot, order: nextSessionOrder(entry.sessions) }],
      };
      await this.save(all);
    });
  }

  /** 在锁内移除一个槽。条目 / 槽不存在则什么都不做（幂等，删两次不炸）。 */
  async removeSession(entryId: string, sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load();
      const idx = all.findIndex((e) => e.id === entryId);
      if (idx === -1) return;
      const entry = all[idx];
      const kept = entry.sessions.filter((s) => s.id !== sessionId);
      if (kept.length === entry.sessions.length) return; // 没这个槽 → 不必写盘
      all[idx] = { ...entry, sessions: kept };
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
