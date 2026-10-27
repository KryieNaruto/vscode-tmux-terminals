import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Society, SocietyLevel, SocietyRole, levelLabel, levelGuide, levelMemory } from './core/society';
import { EntryStore, newConversationId, newId } from './core/store';
import { TerminalEntry } from './core/types';
import { SocietyStore } from './societyStore';
import { TerminalManager } from './terminalManager';
import { messagesPath, sendScriptPath } from './messaging';
import { taskFilePath, taskScriptPath } from './taskLine';
import { devRequestScriptPath, devRequestsPath } from './devRequest';

/**
 * 用户可手动添加的层级，顺序即选择框里的展示顺序（产品经理 → 架构师 → 开发组组长）。
 * 开发者（dev）不在其中：它只由组长通过 create-dev.py 任命，见 processDevRequests。
 */
const LEVELS: readonly SocietyLevel[] = ['product', 'architect', 'lead'];

/** 批量恢复时每个角色之间的错峰间隔，与 restoreAll 的 50ms 同源。 */
const RECOVER_GAP_MS = 50;

/**
 * society（协作模式）的命令层。
 *
 * 只做「弹框收集输入 → 落盘 → 起终端」这三步；数据形状见 core/society.ts，
 * 持久化见 societyStore.ts，终端打开复用 TerminalManager.openSession。
 *
 * **一次角色创建要么全成、要么什么都不落**：所有弹框都在写盘之前问完，
 * 任一取消直接 return —— 否则会出现「终端条目建了、角色没建」的半成品，
 * 用户在树上既看不到它、也删不掉它。
 */
export class SocietyCommands {
  constructor(
    private readonly societyStore: SocietyStore,
    private readonly store: EntryStore,
    private readonly manager: TerminalManager,
  ) {}

  /** 新建 society：问名字和根目录，任一取消则整体取消。 */
  async createSociety(): Promise<void> {
    const input = await vscode.window.showInputBox({
      title: '新建 society',
      prompt: '输入 society 名称',
      placeHolder: '例如：支付重构',
      ignoreFocusOut: true,
    });
    // 取消（undefined）与空名同样处理：不落任何东西。
    const name = input?.trim();
    if (name === undefined || name.length === 0) return;

    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: '选择根目录',
      title: '选择 society 的项目根目录',
    });
    if (picked === undefined || picked.length === 0) return;

    try {
      this.societyStore.add({
        id: newId(),
        name,
        rootDir: picked[0].fsPath,
        roles: [],
      });
    } catch (err) {
      void vscode.window.showErrorMessage(`新建 society 失败：${String(err)}`);
    }
  }

  /** 给 society 加一个角色：问层级 / 职责 / 目录，然后建条目、建角色、起 claude。 */
  async addRole(society: Society): Promise<void> {
    const levelPick = await vscode.window.showQuickPick(
      LEVELS.map((level) => ({
        label: levelLabel(level),
        description: level,
        level,
      })),
      {
        title: `为「${society.name}」添加角色`,
        placeHolder: '选择角色层级',
      },
    );
    if (levelPick === undefined) return;

    const dutyInput = await vscode.window.showInputBox({
      title: `为「${society.name}」添加角色`,
      prompt: '输入角色职责',
      placeHolder: '例如：负责接口设计与联调',
      ignoreFocusOut: true,
    });
    if (dutyInput === undefined) return;
    const duty = dutyInput.trim();

    // 问角色**工作目录**（真实代码目录，角色负责这个目录的职级范围）。
    // 预填 society 根目录，用户往下选（如 apps/android/）。
    const dir = await this.pickRoleDir(society, society.rootDir);
    if (dir === undefined) return;

    try {
      await this.createRole(society, levelPick.level, duty, dir);
    } catch (err) {
      void vscode.window.showErrorMessage(`添加角色失败：${String(err)}`);
    }
  }

  /**
   * 从「目录已知」开始创建角色：落 CLAUDE.md / memory.md、建终端条目与角色、起 claude。
   *
   * 失败一律 throw（目录建不出 / append 失败）；是否弹窗由调用方决定——
   * 用户手动添加走 addRole，组长任命走 processDevRequests，后者不该弹一串错误框。
   */
  private async createRole(
    society: Society,
    level: SocietyLevel,
    duty: string,
    dir: string,
  ): Promise<void> {
    // id 提前生成：roleId 用于派生记忆子目录，保证每个角色各占一个子目录，
    // 避免多个角色申领同一代码目录时，各自的 CLAUDE.md / memory.md 互相覆盖。
    const entryId = newId();
    const roleId = newId();

    // 记忆文件放 <工作目录>/.society/roles/<roleId>/ 下，不污染代码目录正文。
    const memoryDir = path.join(dir, '.society', 'roles', roleId);
    // 目录/CLAUDE.md/memory.md 都建不出来，角色就不知道自己在哪、是谁。
    this.seedRoleDir(dir, memoryDir, duty, level, roleId, society.rootDir);

    // 条目带 order: 0 —— append / openSession 两处签名都能直接吃，
    // 真正的 order 由 EntryStore.append 在锁内重排。
    const entry: TerminalEntry = {
      id: entryId,
      name: duty,
      cwd: dir,
      profile: 'ccr',
      autoRestore: true,
      order: 0,
      systemPromptFile: path.join(memoryDir, 'CLAUDE.md'),
      sessions: [{ id: newId(), conversationId: newConversationId(), order: 0 }],
    };

    const role: SocietyRole = {
      id: roleId,
      name: '',
      level,
      duty,
      dir,
      terminalEntryId: entryId,
    };

    await this.store.append(entry);
    this.societyStore.update({
      ...society,
      roles: [...society.roles, role],
    });

    // 起 claude 失败不致命：角色与条目已落盘，用户可在树上点开恢复。
    try {
      await this.manager.openSession(entry, entry.sessions[0]);
    } catch {
      // 静默：这是后台/手动两条路共用的创建路径，不能在这里弹窗。
    }
  }

  /** 组长任命一个开发者到某个子模块目录（level 固定 dev）。由 processDevRequests 调用。 */
  async createDev(society: Society, dir: string, duty: string): Promise<void> {
    await this.createRole(society, 'dev', duty, dir);
  }

  /** 消费 dev-requests.json 里 pending 的任命请求：逐个 createDev，落盘成功就标记 done。 */
  async processDevRequests(society: Society): Promise<void> {
    const file = devRequestsPath(society.rootDir);
    let data: { requests: Array<{ id: string; dir: string; duty: string; status: string }> };
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return; // 没有请求文件或解析失败 → 无事可做
    }
    let changed = false;
    // createRole 是整份 society 的「读-改-写」：一轮里有多条 pending 时，
    // 继续拿入参那份会把刚加进去的角色覆盖掉，所以每次都重读最新快照。
    let current = society;
    for (const req of data.requests ?? []) {
      if (req.status !== 'pending') continue;
      try {
        await this.createDev(current, req.dir, req.duty);
        req.status = 'done';
        changed = true;
        current = this.societyStore.findById(society.id) ?? current;
      } catch (err) {
        // 落盘失败（目录建不出 / append 失败）不标记 done，留到下一轮重试。
        void vscode.window.showErrorMessage(`创建开发者「${req.duty}」失败：${String(err)}`);
      }
    }
    if (changed) {
      // 原子写，照 roster.ts 的 tmp+rename。
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmp, file);
      } catch (err) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          // 清临时文件失败不盖住真错
        }
        throw err;
      }
    }
  }

  /** 打开一个角色对应的终端（找不到条目时只提示，不新建）。 */
  async openRole(role: SocietyRole): Promise<void> {
    const entry = await this.entryFor(role);
    if (entry === undefined) {
      void vscode.window.showWarningMessage('找不到该角色对应的终端条目');
      return;
    }
    try {
      await this.manager.openSession(entry, entry.sessions[0]);
    } catch (err) {
      void vscode.window.showErrorMessage(`打开角色「${role.duty}」失败：${String(err)}`);
    }
  }

  /** 批量恢复一个 society：逐个角色打开，角色之间留 50ms 错峰避免 tmux 惊群。 */
  async recoverSociety(society: Society): Promise<void> {
    if (society.roles.length === 0) {
      void vscode.window.showInformationMessage('该 society 还没有角色');
      return;
    }
    for (let i = 0; i < society.roles.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, RECOVER_GAP_MS));
      await this.openRole(society.roles[i]);
    }
  }

  /** 删除一个角色：先弹确认，再删对应终端条目（含在跑会话），最后从 society 移除角色。 */
  async removeRole(society: Society, role: SocietyRole): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `删除角色「${role.duty}」？对应的终端与在跑的 claude 会一并终止。`,
      { modal: true },
      '删除',
    );
    if (pick !== '删除') return;

    const entry = await this.entryFor(role);
    if (entry !== undefined) {
      await this.manager.removeEntryQuietly(entry);
    }
    this.societyStore.update({
      ...society,
      roles: society.roles.filter((r) => r.id !== role.id),
    });
  }

  /** 角色 → 终端条目。角色只记 id，条目的真相始终来自 store。 */
  private async entryFor(role: SocietyRole): Promise<TerminalEntry | undefined> {
    return (await this.store.load()).find((e) => e.id === role.terminalEntryId);
  }

  /** 问角色工作目录（直接弹目录选择器，预填 society 根目录）。返回 undefined = 取消。 */
  private async pickRoleDir(society: Society, workspaceDir: string): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: '选择角色工作目录',
      title: '选择角色工作目录',
      defaultUri: vscode.Uri.file(workspaceDir),
    });
    if (picked === undefined || picked.length === 0) return undefined;
    return picked[0].fsPath;
  }

  /**
   * 在角色目录里落下两个文件，让角色一启动就知道自己是谁、记忆放哪、怎么记：
   *
   * - `CLAUDE.md`：claude 在 cwd 自动加载，写角色身份 + memory.md 的追加日志约定。
   * - `memory.md`：角色记忆，追加日志，自判压缩（推翻旧结论或篇幅过长才重写摘要）。
   *
   * 内容模板故意写得跟「追加日志」四个字一一对应，避免 AI 把记忆文件当普通笔记。
   */
  private seedRoleDir(
    workDir: string,
    memoryDir: string,
    duty: string,
    level: SocietyLevel,
    roleId: string,
    societyRootDir: string,
  ): void {
    fs.mkdirSync(memoryDir, { recursive: true });
    const levelName = levelLabel(level);
    const memoryFile = path.join(memoryDir, 'memory.md');

    // CLAUDE.md 放记忆目录，经 --append-system-prompt-file 注入。claude 的 cwd
    // 是工作目录（代码目录），`./memory.md` 会解析到错地方，所以写绝对路径。
    const globalFile = path.join(societyRootDir, '.society', 'global.md');
    const sendScript = sendScriptPath(societyRootDir);
    const messages = messagesPath(societyRootDir);
    const taskScript = taskScriptPath(societyRootDir);
    const taskFile = taskFilePath(societyRootDir);
    const guide = levelGuide(level);
    const devScript = devRequestScriptPath(societyRootDir);
    // 任命开发者是组长的特权：其他层级不写这一节，免得人人乱建 dev。
    const appointDev = level === 'lead'
      ? [
          '## 任命开发者（建子模块开发）',
          '',
          '需要某个子模块的开发者时，用脚本请求扩展创建，不要手动建：',
          '',
          `  python3 ${devScript} "<子模块目录绝对路径>" "<职责>"`,
          '',
          '扩展会在 10 秒内自动在该目录创建开发者角色并起 claude 会话；之后读全局身份表确认新成员在线。',
          '',
        ]
      : [];
    const memoryHint = levelMemory(level);
    const claudeMd = [
      '# 角色',
      '',
      '你是这个 AI society 的一名成员。',
      '',
      `- 层级：${levelName}`,
      `- 职责：${duty}`,
      `- 工作目录：${workDir}`,
      '',
      '## 给自己起名',
      '',
      '第一次开工先给自己起一个名字,把记忆文件头部 `- 名字：（待起）` 那行的括号换成你的名字。之后一直沿用,不要改。',
      '',
      '## 你的职责与协作（逐层委派，不跳层）',
      '',
      guide.duty,
      '',
      `- 直接上级：${guide.up}`,
      `- 直接下级：${guide.down}`,
      '- 协作铁律：只跟直接上级/下级通信，不跳层。找协作对象时先读下方的全局身份表，按层级挑直接上下级。',
      '',
      '## 找其他成员（全局身份表）',
      '',
      `需要找其他角色协作时，先读 \`${globalFile}\`，按层级/职责/状态挑出候选再决定联系谁，不要先读代码。`,
      '',
      '## 通信（给其他成员发消息）',
      '',
      '发消息给其他角色：先读上方的全局身份表找到目标角色的「终端 ID」，然后执行：',
      '',
      `第一个参数永远填你自己的角色 ID(\`${roleId}\`),不要填别的。`,
      '',
      `  bash ${sendScript} "${roleId}" "<终端ID>" "<消息文本>"`,
      '',
      `收到「[society] 你有一条新消息」提示时，读 \`${messages}\` 末尾那条发给你的消息，履行职责；完成后回发消息，并把结论追加进 memory.md。`,
      '',
      '## 任务线（用脚本读写，禁止直接改）',
      '',
      `任务记录在 \`${taskFile}\`。读写一律用脚本，不要直接改文件：`,
      '',
      `  python3 ${taskScript} add "<标题>" --level outline|module [--parent <任务id>] [--assignee <层级>]`,
      `  python3 ${taskScript} list [--status todo|doing|done|rejected]`,
      `  python3 ${taskScript} update <任务id> <todo|doing|done|rejected>`,
      '',
      '粗纲（outline）由产品经理/架构师写，细粒度模块（module）由组长拆；完成或打回都用 update 更新状态。',
      '',
      ...appointDev,
      '## 记忆（memory.md）',
      '',
      `你的记忆文件是 \`${memoryFile}\`。用法：`,
      '',
      '1. **完成任务必记（压缩保存）**：每完成一个任务，必须把该任务的最终结论/产出/状态追加进 memory.md 末尾一条（带时间戳）——这是其他角色经全局身份表检索你上下文的凭证，不可省略；其余有值得记的结论/决策/状态也照此追加，不要改动已有的条目。',
      '2. **重写摘要**：只有当你自己判断——新内容推翻了前面的结论，或文件篇幅过长——才把「日志」段整体重写成一段摘要（保留文件头部的身份信息与这条约定）。',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(memoryDir, 'CLAUDE.md'), claudeMd, 'utf8');

    const memoryMd = [
      `# 记忆 — ${duty}`,
      '',
      '- 名字：（待起）',
      `- 层级：${levelName}`,
      `- 职责：${duty}`,
      `- 工作目录：${workDir}`,
      `- 记忆重点：${memoryHint}`,
      '',
      '## 日志',
      '',
      '（追加，不改历史。推翻旧结论或篇幅过长时，把「日志」整段重写为摘要。）',
      '',
    ].join('\n');
    fs.writeFileSync(memoryFile, memoryMd, 'utf8');
  }
}
