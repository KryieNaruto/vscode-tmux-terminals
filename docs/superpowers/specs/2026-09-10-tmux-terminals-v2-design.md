# Tmux Terminals v2 设计：条目排序、目录提示、profile/模型切换、杀会话修复

日期：2026-09-10
状态：待用户评审
关联：`2026-09-09-vscode-tmux-terminals-design.md`（v1）

## 1. 背景

v1 已上线并在用（远端 6 个真实条目）。实际使用暴露 4 个问题，全部由用户提出：

1. 条目顺序不可调，只能按添加顺序排。
2. 新建条目要手打完整远程目录，且列表里显示完整路径、占宽又难扫。
3. 所有条目的 `commands` **实际全是同一句** `claude --dangerously-skip-permissions`（6/6 实测），但额度用完时需要在 ccr / direct 两个 profile 间切换，并在切换后接回原对话 —— 目前只能手敲 `/exit`、`claude-direct ...`、`/resume`，极繁琐。
4. 杀掉 tmux 会话后，右侧终端面板不关闭，且会再次连上，导致 UI 显示与实际不符。

## 2. 术语：什么是 profile

本机上 `claude` 有两个入口，差别在**鉴权与模型来源**：

| profile | 命令 | 配置 | 模型默认 |
|---|---|---|---|
| `ccr` | `claude` | `~/.claude/settings.json`（`ANTHROPIC_BASE_URL=http://127.0.0.1:3460` 本地中转） | `deepseek-v4-flash` |
| `direct` | `claude-direct` | `claude --settings /etc/claude/direct.json`（官方直连） | `claude-sonnet-5[1m]` |

**额度用完时用户要切换的是 profile**，不是 `/model` 能解决的事 —— 它换的是鉴权与端点。而 profile *内部*的模型切换（`deepseek-v4-pro` ↔ `qwen3.7-max`）才是 `/model`。

## 3. 设计前已验证的前提（实验证据）

本项目惯例：**设计依赖 tmux/CLI 行为时，先做实验再设计**。v1 的教训（`-t` 前缀匹配曾导致 attach 到错误会话）正是这么发现的。

| # | 假设 | 实验 | 结论 |
|---|---|---|---|
| 1 | `/model` 接受行内参数 | tmux 里跑真 CLI，发 `/model deepseek-v4-pro` | ✅ 生效：状态栏 `🤖 deepseek-v4-flash` → `🤖 deepseek-v4-pro`，回显 `Set model to deepseek-v4-pro` |
| 2 | 行内 `/model` 会改写全局默认 | 检查 `~/.claude/settings.json` | ⚠️ **会**：`model` 被改成 `deepseek-v4-pro`（探针后已还原为 `deepseek-v4-flash`） |
| 3 | `--model` 启动参数是否也污染全局 | `claude --model deepseek-v4-pro -p ...` | ✅ **不污染**：`model` 字段保持不变 |
| 4 | 两个 profile 是否共用会话记录 | 查 `direct.json` 是否覆盖 `projects` 目录 | ✅ **共用** `~/.claude/projects/` → `--continue` 可跨 profile 接回原对话 |
| 5 | kill-session 后客户端是否跳转到别的会话 | 真实 pty（`script`）attach 一个会话，另一会话存活，然后 kill | ❌ **不跳转**：客户端打印 `exited` 并退出（假设被证伪） |
| 6 | 是否有 shell 层自动 attach | 查 `.bashrc` / `.bash_profile` / `.profile` / `.zshrc` / `.tmux.conf` | ❌ 全无 tmux 相关配置 |

前提 5、6 的证伪直接改变了第 4 个问题的归因，见 §8。

## 4. 数据模型

```ts
export type Profile = 'ccr' | 'direct';

export interface TerminalEntry {
  id: string;
  name: string;
  cwd: string;
  /** 决定启动命令与鉴权来源；取代 v1 的 commands[] */
  profile: Profile;
  /** 空 = 用该 profile 的默认模型 */
  model?: string;
  autoRestore: boolean;
  /** 拖拽排序用的序号，从 0 递增；不保证连续 */
  order: number;
}
```

**命令由 profile 推导，不再是数据**：

```ts
export function commandFor(entry: TerminalEntry): string {
  const exe = entry.profile === 'direct' ? 'claude-direct' : 'claude';
  const model = entry.model ? ` --model ${shellQuote(entry.model)}` : '';
  return `${exe} --dangerously-skip-permissions${model}`;
}
```

理由：v1 把命令做成自由数据，但 6 个条目 100% 是同一条命令 —— 这份灵活性是假的，代价却是每次新建都要手敲一遍。改成派生后，启动方式只有一处定义。

### 4.1 迁移

v1 的 `terminals.json` 里是 `commands: string[]`，`model`/`order` 不存在。载入时逐条迁移：

- `commands` 中任一含 `claude-direct` → `profile: 'direct'`，否则 `'ccr'`
- `model` → `undefined`（用 profile 默认，不猜）
- `order` → 原数组下标
- 迁移前把原文件备份为 `terminals.json.bak`（只备份一次，已存在则跳过）
- 迁移后的文件**不立即回写**，等下一次真实写入时自然落盘 —— 避免"只是打开扩展就改了用户文件"

迁移函数放 `src/core/migrate.ts`，纯函数、零 vscode 依赖，单独测试。

## 5. 条目显示

- 标签：`name`（不变）
- `description`：**目录的 basename**，如 `workspace`、`strip-qt-ui`
- 重名消歧：basename 与他人冲突时补一层父目录，如 `paint_workspace/strip-qt-ui`。用户现有 6 条中有 3 组重名（`workspace`×3、`strip-qt-ui`×3），必须处理
- 颜色：徽标 `ThemeIcon` 上色表 profile —— `ccr` 用 `charts.blue`，`direct` 用 `charts.orange`
  - 注：v1 曾在**活动栏图标**上用 `currentColor` 导致图标不可见。那是活动栏独有的 CSS mask 渲染路径；**树内 `ThemeIcon` 颜色是另一条路径**，v1 的存活绿点（`terminal.ansiGreen`）已在用且显示正常。此处有先例，风险已排除
- tooltip：保留完整信息（全路径、profile、模型、存活状态、是否参与全部恢复）

## 6. 拖拽排序

- 实现 `TreeDragAndDropController<TreeNode>`，注册到 `createTreeView`
- 落点语义：拖到目标行 = **插到该行之前**（`TreeDropType.Before` 之外的落点一律按"之前"处理，语义唯一、不产生歧义）
- 持久化：重排后统一写回 `order`（`0..n-1` 重新编号，避免序号无限增长）
- **必须复用 `EntryStore` 已有的 `enqueue` 串行化**：连续快速拖拽会并发触发多次"读-改-写"，v1 已因此踩过丢更新的坑
- 拖拽期间不调用 tmux，纯本地顺序调整，不碰任何会话

## 7. 面板：批量操作（第二个 view）

同一容器 `tmuxTerminals` 下新增第二个 view：

```
▾ 终端清单                        [全部恢复] [+]
    统筹者                     workspace
    咨询                       workspace
───────────────────────────────────────
▾ 批量操作            [直连] [中转] [模型] [清空]
  ○ 统筹者
  ● 咨询                     ← 高亮选中
```

- view id：`tmuxTerminals.batch`，标题「批量操作」，与「终端清单」同属 `tmuxTerminals` 容器
- 条目与清单一致（同样显示短路径）
- **点击 = 切换选中态**，不打开终端（与清单的"点击即打开"明确区分）
- **选中态由复选框图标承载**，不依赖 VS Code 的原生高亮。原因：原生高亮跟随**焦点**，用方向键浏览时高亮会移动，把"高亮"当"已选"会造成误操作（以为选中了 3 条，实际只有 1 条）。因此：
  - 已选 → 实心 `check` 图标 + `charts.blue`
  - 未选 → `circle-large-outline` 图标，无色
  - 焦点高亮照常跟随键盘，**不作为选中语义**
- 选中集合存扩展内存（`Set<string>`，条目 id），不落盘；扩展重载后清空（符合"临时操作态"语义）
- 标题栏按钮：`设为直连`、`设为中转`、`设置模型…`、`清空选择`
- 条目删除后需从选中集合里剔除，避免对已删条目执行操作

## 8. 模型 / profile 切换

### 8.1 作用于未运行的会话

只改配置。下次 `openEntry` 时由 `commandFor` 带出 `--model`（前提 3：不污染全局）。零副作用。

### 8.2 作用于运行中的会话（用户选择「立即生效」）

- **仅改模型** → 往会话发 `/model <名称>`（前提 1：行内参数生效）
- **改 profile** → `/exit` → 等回到 shell → 发 `<命令> --continue`（前提 4：共用会话记录，能接回原对话）

**默认模型如何指定**：`/model <名称>` 会把名称写进全局默认（前提 2）。当目标模型**恰好等于**该 profile 的默认模型时，应改用「`/exit` 后重启且不带 `--model`」来达成，避免写全局。二者行为等价（都回到默认），但后者无副作用。这是本设计里唯一为规避副作用而绕的路，值得。

### 8.3 不变量（沿用 v1 的安全铁律）

> **只在「会话存活」且「前端确认当前运行的是 claude」时，才发送控制序列。**

- 判据：`tmux display-message -p -t '=<会话>:' '#{pane_current_command}'` 解析出的基名**以 `claude` 开头**（覆盖 `claude` / `claude.exe`）
- **不得放宽到 `node`**：用户的 build、测试、dev server 大量是 node 进程，把 `node` 纳入判据等于守卫失效，一条 `/exit` 就会打断真实工作
- 识别不出 → **拒绝执行并说明原因**，绝不当作键盘输入盲发
- 复用 v1 已修好的 `isShellReady` 与 `paneTarget`（`=<名字>:` 必须带冒号，`=<名字>` 会静默失败）

### 8.4 批量执行

对选中集合逐条执行，逐条独立捕获异常（沿用 `restoreAll` 的写法）：一个条目失败不影响其余。批量结束后汇报「成功 N 条 / 跳过 M 条（附原因）」。条目间轻微错开，避免并发争抢。

## 9. 目录输入提示

`askCwd` 从纯输入框改为 QuickPick：

- 候选来源（去重、排序）：
  1. 手动输入…（首项，打开原输入框）
  2. 现有条目已用过的 cwd（对高频目录最有用）
  3. 上述每个 cwd **自身**下的直接子目录
  4. 上述每个 cwd 的**父目录**下的直接子目录
  5. `~` 下的直接子目录（兜底）
- 仅列**一层**，避免扫描开销；输入框仍支持 `~` 展开
- 候选目录个数上限（如 50），超出截断并在提示里说明

> **订正（2026-09-10，发布后实测）**：本节原第 3、4 条写的是「`~` 下的直接子目录」
> 与「`~/workspace` 下的直接子目录」。第 4 条是一个关于「工作区在哪」的**猜测**，
> 实测当场证伪：本机 home 是 `/home/qiansenwei`，而工作树在
> `/ssd/qiansenwei/workspace` —— 两者毫无关系。后果是候选 26 条里 24 条来自
> `~/`（用户从不使用），而用户真正在用的树**除已存过的两条外一条都不出现**，
> 用户报「没有显示 workspace/ 下的 mine」。现改为以「已用过的 cwd」为扫描根
> （自身 + 父目录），随用户实际用法自动扩张；不再硬编码任何家目录下的路径。
> 教训：**凡是关于「用户把东西放在哪」的硬编码都是待爆的 bug**，能由数据推出的
> 就不要猜。

## 10. 杀会话修复（问题 4）

用户描述：杀掉 tmux 后，右侧终端面板**没有关闭**，且**又连接上了**。

实验 5、6 证伪了"客户端跳转到其他会话"与"shell 自动 attach"两条解释。剩余可自洽的解释是：

> 面板未关 → 终端进程实际已退出 → VS Code 触发 `onDidCloseTerminal` → `TerminalManager.terminals` 里的映射被清空 → 用户再点该条目时 Map 未命中 → 扩展走完整 `openEntry`（建会话 + attach）→ 表现为「又连上了」。

该解释同时吻合三个观察（UI 说无会话、面板还在、一点就连上）。因无法在用户机器上完全复现到最后一环，本节按**防御性修复**处理：把每一个可能的入口都堵上。

### 10.1 修改 `killSession`

1. 二次确认（保留，文案补充"对应终端也会关闭"）
2. `tmux detach-client -s '=<会话>'` —— 先摘掉客户端，杜绝任何残留 attach
3. `tmux kill-session -t '=<会话>'`
4. **`terminal.dispose()` 关闭对应面板**
5. 从 `terminals` Map 删除映射
6. 立即刷新存活状态

### 10.2 新增守卫：`openEntry` 按名复用面板

Map 未命中时，先按终端名在 `vscode.window.terminals` 里查找同名终端，命中则复用并 `show()`，**不再新开面板**。

理由：Map 是内存态，扩展宿主重启后会清空，而面板仍在。没有这道守卫就会出现「两个面板连着同一个会话」，并再次制造 UI 与实际不符。

> **订正（2026-09-10，v0.1.1 发布后实测）：「按名复用」不足以断定会话已恢复。**
>
> 用户症状：「批量恢复功能没有用，只能恢复到 cd 那一层，不会调用 claude。」
>
> 根因：本节这道守卫与它前面的 Map 命中分支，都是**非权威信号**，命中即
> `show()` 并 return —— 既不验证 tmux 会话是否还在，也不验证有没有客户端
> 附着。两种真实后果：
>
> - **会话已死 + 同名面板 → 完全 no-op。** 面板当初是以 `{cwd}` 建的，
>   tmux 客户端一退出它就退回该目录下的裸 shell，正是用户看到的
>   「只恢复到 cd 那一层」。
> - **会话存活但 `#{session_attached}` 为 0 + 同名面板 → 只 `show()`，
>   不 attach。** claude 在后台跑着，用户却看不见。真机铁证：用户 7 个
>   `tmuxterm-*` 会话全部存活、pane 前台就是 claude，其中 **6 个附着数为 0**。
>
> **订正后的判据**（落在 `src/core/restore.ts` 的 `decideOpen`，纯函数，可单测）：
> **权威事实只有两个** —— `tmux has-session` 的结果、该会话的
> `#{session_attached}`。内存 Map 与「终端同名」只用来回答「用哪个面板」，
> 绝不用来断定「已经恢复好了」。对每条条目必须保证：**会话存在 +
> 至少一个客户端附着 + 有一个面板在显示它**。
>
> - 会话存在 + 附着数 ≥ 1 + 有面板 → `show`（已恢复，不重复 attach）；
> - 否则一律真正接上：能证明候选面板空闲 → 复用该面板并发 `tmux attach`，
>   否则新建面板。
> - 附着数读不出来（`null`，即 `display-message` 静默失败）**不**满足
>   「已恢复」—— 宁可重复 attach 一次，也不能漏掉一次真正的恢复。
>
> **新增安全闸门（复用面板前必须过）**：面板里可能正跑着用户的编译，
> 把 `tmux attach` 塞进它的 stdin 能毁掉一次构建。因此只有能**证明**面板
> 空闲停在 shell 提示符上（`terminal.shellIntegration` 在场且
> `onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`
> 未报有命令在跑）才允许往里打字；判不出来一律新建面板 —— 宁可多一个面板。
> 该 API 自 VS Code 1.93 起提供，缺失时整条判据降级为「一律判不出来」，
> attach 照常发生。

## 11. 不变量清单（实施与测试必须守住）

1. 竞态兜底**只能把命令降级为不发，永远不能凭空加出命令**（v1 原文，措辞按 §15 订正）
2. 控制序列只在「会话存活且前端确认是 claude」时发送，否则拒绝并说明
3. 任何"会话可能属于别人"的迹象 → 一律不发送
4. 拖拽重排只改本地顺序，绝不触发 tmux 操作
5. 迁移不得丢失用户已有条目；改写前先备份
6. `=<名字>:` 必须带冒号（`=` 精确匹配 + pane 级目标）
7. **「已恢复」只有两个权威判据：`has-session` 与 `#{session_attached}`。**
   内存 Map、`window.terminals` 同名命中只能用来说明「用哪个面板」，
   绝不能说明「已经恢复好了」（§10.2 订正）
8. **绝不往「状态不明」的面板里打字。** 复用面板前必须能证明它空闲停在
   shell 提示符上（shell integration 在场且无命令在跑）；判不出来一律新建
   面板 —— 宁可多一个面板，也不能打断用户正在跑的编译
9. **往会话里发送启动命令的唯一闸门是「pane 前台确实是登录 shell」**
   （`isShellReady`，绝不放宽到 `node`）。前台是 claude → 对话原样在跑，
   只 attach、绝不打扰；前台是别的进程（编译、REPL）或读不出 → 一律不发送。
   *（本条取代了 v2 首发时的「会话存活就一律不发送」—— 那条在 claude 已
   退出时会把用户困在裸 shell 里，见 §15。）*
10. **有 `conversationId` 就必须 `--resume` 那一条，绝不重开新对话顶替**
    （§15）
11. **没有绑定就不要猜。** 该 cwd 下有候选对话时问一次用户并永久记住。
    用户按 Esc 取消 = **什么都不启动**（会话照常建/照常 attach），绝不退回
    `--continue`（共用 cwd 下会一起接到同一条最新对话）

## 12. 验证方式

- **纯函数层**（`src/core/`）：`commandFor` / `conversationCommand`、`migrate`、短路径消歧、`restore`（decideOpen）、`conversation`、`claude`（isShellReady 在 `tmux.ts`）的测试 —— TDD，先写失败测试
  （`planRestore` 与 `src/core/plan.ts` 已在 §14/§15 的订正里删除，它的位置由 `tmux.ts#isShellReady` 那道闸门取代）
- **清单测试**（`test/manifest.test.ts`）：新增第二个 view 的 id/容器一致性；标题栏按钮的 `when` 条件与命令 id 一一对应
- **e2e 脚本**（`test/e2e-harness.js`）：扩展为覆盖
  - 杀会话 → 面板确实被 dispose、Map 确实清空
  - 运行中的 claude 会话发 `/model` 后，状态栏确实变化（读 pane 内容断言）
  - **非 claude 会话（如 `sleep`）上执行切换 → 必须被拒绝**（守卫的反向测试，本项目最重要的一类测试）
- 每个守卫必须做**变异测试**：故意破坏守卫，确认对应测试真的失败（v1 的做法，曾借此发现"测试只断言了存在、没断言内容"的漏洞）

## 13. 已知取舍与风险

| 项 | 取舍 |
|---|---|
| 失去任意命令能力 | 由 profile 派生命令，换取了集中定义。若日后需要 per-entry 自定义命令，再加可选 `extraArgs` 字段 |
| `/model` 写全局默认 | 仅在"目标模型≠profile 默认"时使用，其余走重启；无法完全避免，已在 §8.2 说明 |
| 批量选中不落盘 | 扩展重载后清空，符合"临时操作态"的语义 |
| 切换 profile 会中断当前 claude 进程 | 这是用户明确要求的"立即生效"的必然代价；`--continue` 接回对话降低损失 |
| 目录候选只扫一层 | 换取不卡顿；深层目录仍需手输 |

## 14. 实施后修订

（本节在实施完成后回填，记录与设计不符之处，沿用 v1 的做法）

### 订正（2026-09-10，v0.1.1 发布后实测）：「全部恢复」不 attach

- **症状**：批量恢复只恢复到 cd 那一层，不会调用 claude。
- **根因**：§10.2 的「按名复用」与它前面的 Map 命中分支把**非权威信号**
  当成「已恢复」，命中即 `show()` + return。会话已死时完全 no-op；
  会话存活但 0 附着时只 show、不 attach。
- **修法**：新增纯函数 `src/core/restore.ts#decideOpen`，判据改为
  `has-session` + `#{session_attached}`（`TmuxClient.attachedClients`）+
  候选面板空闲态；新增复用面板前的 shell-integration 安全闸门。
  `e2e-harness.js` 第 6 节原先把「同名面板存在 → 不新建终端」当作正确行为
  断言（只断言 `calls.terminals.length === 0`，从不断言会话被恢复），
  这正是它当初没能拦住这个 bug 的原因，已一并重写为四种组合的行为断言。
- **未改动的部分（有意保留）**：会话原本就存活时，**仍然**不发送
  `commandFor(entry)` 派生的启动命令。因此「存活会话的 pane 只是裸 shell」
  不会自动补发 claude —— 那是另一件事，需与用户确认后再做。
  *（这一条已被下面的修订取代，见 §15。）*
- **验证**：`npm test`（含新增 `test/core/restore.test.ts`、`parseAttachedCount`
  单测与 `attachedClients` 集成测试）、`node test/e2e-harness.js` 全绿；
  三处变异测试（退回「命中即 show」、空输出当成 0、去掉 idle 闸门）均被
  对应测试捕获。

### 订正（2026-09-10，同上，用户补充需求）：条目 ↔ 对话绑定

- **症状**：批量恢复后「会话全部清空」，claude 进去还要手动 `/resume` 翻列表，
  且多个条目共用同一 cwd 时分不清哪个终端对应哪条对话。
- **根因**：恢复已死会话时用的是**裸 `claude`**（`commandFor` 不带任何
  resume 参数）→ 开了一条全新对话，把原来的顶掉。上一行的「存活会话的 pane
  只是裸 shell 时也绝不补发命令」在 claude 已退出时会把用户困在裸 shell，
  同样是「回不到原对话」。
- **修法**：给条目永久绑定 `conversationId`（§15）；恢复时一律
  `--resume <它>`；首次启动用 `--session-id` 开一条并绑定；老条目问一次。
  发送闸门从「会话是否存活」改为 **`isShellReady(pane 前台进程)`** ——
  claude 在跑就只 attach，claude 已退出才启动（§11 第 9 条）。
  `restartClaude` 的 `--continue` 也一并改为「有绑定就 `--resume`」。
- **删除**：`src/core/plan.ts`（及其测试）。它把已过时的
  「存活 → 不发命令」+「裸 claude」写成了单一动作，语义已被取代。
- **验证**：`npm test`（新增 `test/core/conversation.test.ts`、
  `test/conversationFiles.test.ts`，扩展 command/migrate 测试）、
  `node test/e2e-harness.js`（重写为 12 节，含「已死→--resume」「claude 在跑→
  只 attach」「claude 已退出→--resume」「老条目询问/取消」「切 profile 用
  --resume」）全绿；五处变异测试（resume 退化成 --continue、迁移吞掉
  conversationId、cwd 归属退化成前缀匹配、从不询问、去掉 shell-ready 闸门）
  均被对应测试捕获。

### 订正（2026-09-10，第三次）：删掉 `--continue`，新条目在创建时绑定

上一轮把「用户取消选择」退化成 `--continue`，并把「新建条目」和「老条目」
都留在「无 conversationId」这一种状态里。审查后两处都改：

- **`--continue` 兜底彻底删除**（连同 `restartClaude` 里的那一处）。理由见
  §15.4：条目共用 cwd 时它会带着几个终端一起接到同一条最新对话上，两个
  claude 同时写同一个 `.jsonl`。取消 = 什么都不启动；新对话只能由用户在
  选择框里主动选「＋ 新建一条对话」；切 profile 时无绑定则拒绝重启。
- **新条目在 `addEntryInteractive` / `duplicateEntry` 时分配 `conversationId`**，
  于是「无 conversationId」此后只剩「本功能上线前的老条目」一种含义，
  问它就是完全正确的；新建条目永远不会被弹选择框。
- 由此引出「已绑定 ≠ 对话已存在」，用 `findConversations()` 按 id 直查来区分
  `--session-id`（建出来）与 `--resume`（接回），不引入额外的状态字段。
- **`--resume` 失败要看得见**（§15.4 末段），否则用户只会觉得「又没接上」。

- **验证**：`npm test` 220 passing；`node test/e2e-harness.js` 全绿（15 节，
  含「新建条目不问且用 --session-id」「Esc → 零发送」「无绑定切 profile → 拒绝」
  「--resume 报错可见」「绑定对话在别的 cwd → 拒绝且不另开」）；
  六处变异测试（Esc 隐式开新对话、无绑定不拒绝、不看 pane、忽略 cwd 匹配、
  不区分「尚未创建」、cwd 冲突照发 --resume）均被对应断言捕获。

### 订正（2026-09-10，第四次）：两处「静默」补掉

- **绑定的对话没有记录时出声**（行为不变，加一条 info）—— 覆盖「记录被外部
  删除」这个此前静默的残留（§15.4）。
- **选中已绑给别的条目的对话 → 模态二次确认**，`openEntry` 与
  「选择要接回的对话…」两个入口都过闸（§15.4）。这是「两条条目共写一条
  `.jsonl`」的最后一条缝：此前只靠标签提示。
- **不改**：改 cwd 导致绑定失效维持现状（报错 + 指向「选择要接回的对话…」）——
  自动清空绑定等于静默丢关联，宁可吵一声、可恢复。
- **验证**：`npm test` 226 passing；e2e 全绿（新增 §2 出声断言、§6b 确认闸
  两条分支、§6c 显式命令入口）；三处变异测试（不出声、不确认、只在一个
  入口确认）均被对应断言捕获。

### 订正（2026-09-10，第五次，独立复核后的四处残余）

- **① busy 状态「未知」必须与「空闲」区分开。** 扩展宿主重载后 `busy` 是空集、
  而 `shellIntegration` 仍在 —— 一个**正在跑编译**的面板会被误判空闲，然后被
  塞进 `tmux attach`。改为只复用**本宿主世代由我们亲手创建**的面板
  （`ownPanels`，所有 `createTerminal` 都经 `createOwnPanel`）；上一个世代的
  面板：会话已附着 → 仍然只 `show()`；需要客户端 → 新建面板。代价是重载后
  可能多一个新面板，接受。
- **② `openEntry` 的 TOCTOU 窗口。** `shellReady` 算出来之后隔着一次可能很久
  的 QuickPick，之后才发送。改为**发送前重算一次** `isShellReady`（一次
  `display-message`），窗口从「用户思考时长」压到毫秒级。
- **③ `pickChain` 只串行化了选择框。** `owners` 快照在 op 内读、`store.update`
  却在 op 外写，两个共用 cwd 的老条目可能都看到「还没人绑」→ 双双接到同一条
  对话上（正是本批提交要防的损坏）。改为**读 owners → 选择框 → 确认模态 →
  写绑定整段在同一个 op 内**；`pickConversation` 自己不再入队，由调用方负责。
  顺带解决确认模态与下一个条目的选择框并存的问题。
- **④ 补两处零覆盖**：`duplicateEntry`（复制品的 `conversationId` 必须重新生成，
  既不等于源、也不是 undefined）与 `openEntry` 的竞态分支（被别的窗口抢先
  创建 → 转接回、绝不发命令）。
- **⑤ 清理**：`rm -rf out` 重编，确认无指向已删 `core/plan` 的陈旧 `.js.map`；
  v1 spec/plan 里把 `plan.ts` 标为 v2 已删除，v2 spec §12 的验证方式改指
  现在的 `isShellReady` 闸门。
- **⑥ e2e 的隔离断言升级为文件级**：原先只比 `~/.claude/projects` 的**目录集合**，
  真 claude 若跑在**已存在**的 project 目录下（只加 `.jsonl`）就抓不到。现在逐
  文件比路径集合，并额外断言「本轮没有任何测试会话的痕迹落进用户真实的库」
  （用户自己的 claude 会话此刻仍在写盘，单独计数、不计入本测试）。

- **验证**：`npm test` 226 passing；e2e 全绿（新增 §6d TOCTOU、§6e 并发串行化、
  §11c/11c2/11e 面板三态、§16 复制、§17 竞态）；三处变异测试（去掉
  `ownPanels` 判定、去掉发送前重算、把写绑定移出 op）均被对应断言捕获。


## 15. 条目 ↔ 对话绑定（2026-09-10 追加）

### 15.1 用户症状

> 点击你的批量恢复，所有会话全部因为 tmux attach，导致变成 history restored，
> 会话全部清空！claude 进去后，也要 resume 去找是哪个会话，和终端完全不能
> 自动对上。**我希望的是批量恢复后，各个会话能回到 claude 各自当时所在的对话中去。**

会话**活着**时不需要任何补救：它的 pane 里就是那条对话，attach 上去即可。
问题全在**会话已死**的那条路径上：旧代码重开会话 + 裸起 `claude` ——
不带任何参数的 `claude` 会开一条**全新对话**，等于把原来的顶掉。用户只能
手动 `/resume` 翻列表，而 `/resume` 里根本分不清哪个终端对应哪条对话
（实测 4 条条目共用 `/ssd/qiansenwei/workspace`、3 条共用同一 strip-qt-ui
目录，各自的候选分别有 15 条和 12 条）。

### 15.2 设计前已验证的前提（实测结论，勿重复实验）

| # | 结论 |
|---|---|
| 1 | `claude --session-id <uuid>` 能指定会话 id，会话文件落在 `~/.claude/projects/<munged-cwd>/<uuid>.jsonl` ✅ |
| 2 | `claude --resume <uuid>` **按 cwd 作用域**：从别的 cwd 运行会报 `No conversation found with session ID` ❌ |
| 3 | 在会话自己的 cwd 里 `claude --resume <uuid>` **能精确接回那条对话** ✅ |
| 4 | claude 进程**不长期持有** .jsonl 的 fd，无法从 `/proc/<pid>/fd` 反查运行中会话的 id ❌ |
| 5 | 每个会话文件里记录了 `"cwd":"<绝对路径>"` —— **枚举候选一律按这个字段筛，不要猜目录名转义规则**（实测 `_` 和 `.` 也会被换成 `-`） ✅ |

第 2 + 5 条决定了设计：**恢复必须在条目自己的 cwd 里 launch**（扩展本来就用
`-c cwd` 建会话，天然满足），而**绑定关系只能由扩展自己记**（第 4 条排除了
反查运行中 claude 的可能性）。

### 15.3 数据模型

`TerminalEntry` 增加 `conversationId?: string`（UUID）。

- **未设只表示「本功能上线前就存在的老条目」**（唯一需要问一次用户的场合）。
  `addEntryInteractive` 在**创建条目时**就分配一个 id，所以新建的条目永远不会
  被弹选择框。
- 迁移（`core/migrate.ts`）**原样带过去，缺字段就保持 undefined，绝不编造**。
  `migrateEntry` 是 `EntryStore.load()` 的唯一守门人，漏一行就会**静默吞掉**
  用户已有的绑定，下一次恢复又变回「新开一条顶掉原来的」。
- `duplicateEntry` **必须重新生成**一个：照抄会让两条会话接进同一条对话，
  两边同时写同一个 `.jsonl`；留空则会被当成「老条目」而在下次恢复时弹选择框。
- **「已绑定」不等于「那条对话已经存在」**：新建条目一出生就带 id，而对话要等
  首次启动才被创建。因此发 `--session-id`（建出来）还是 `--resume`（接回它），
  由 `findConversations()` 按 id 直查文件是否存在决定 —— 不靠额外字段记状态。

### 15.4 决策：`resolveLaunchSpec`

| 情况 | 动作 |
|---|---|
| 已绑定，且那条对话**存在**（在条目 cwd 下） | `--resume <它>` |
| 已绑定，但那条对话**还没被创建** | `--session-id <同一个 id>`（把它建出来）+ **一条 info 出声** |
| 已绑定，但那条对话**在别的 cwd 下** | **什么都不启动** + 报错指向「选择要接回的对话…」 |
| 未绑定 + 该 cwd 下有候选对话 | 弹一次 QuickPick：选中对话 → 绑定并 `--resume`；选「＋ 新建一条对话」→ 绑定新 uuid 并 `--session-id` |
| 未绑定 + 无候选 | `--session-id <新 uuid>`，并把新 id **落到条目上** |
| 用户按 Esc 取消 | **什么都不启动**（会话照常建/照常 attach），给一条指向右键命令的提示；**不绑定** |

候选 = `~/.claude/projects/*/*.jsonl` 中**文件内 `cwd` 字段精确等于**条目 cwd
的那些，按 mtime 倒序；每项显示 `时间 · 首条用户消息摘要 · 体积`。
已被其它条目绑走的对话在标签上标注「已绑给「X」」，避免选重。

**为什么没有 `--continue` 兜底**（2026-09-10 二次修订删掉）：`claude --continue`
接的是「该 cwd 下**最近**的一条对话」。条目共用 cwd 时（实测 4 条同目录），
若几个条目都走它，就会一起接到同一条对话上，两个 claude 进程同时写同一个
`.jsonl` —— 数据损坏级。所以「接哪条」要么由绑定决定，要么由用户当场指定：
**新对话只能由用户主动选「＋ 新建一条对话」产生**，取消是没有结论，不是
「给我开一条新的」。

同理，`restartClaude`（切 profile 用的重启）在**没有绑定**时不再退回复
`--continue`，而是**拒绝并提示先绑定** —— 宁可这次不重启，也不能接到错的
对话上去。`LaunchSpec` 类型里已经没有 `continue` 分支，`conversationCommand`
对未知 kind 直接抛错。

**两条防「静默」的补充（2026-09-10，第四次）**：

- 「绑定的对话还没有记录」时会**出声**（info，不阻断）。这条路径有两种来源、
  数据上不可区分：`+`/复制新建条目的**正常首次启动**，以及那条 `.jsonl` 被
  **外部删掉**（手动 rm、清理工具）。后者若静默，用户只会觉得「我的对话又没
  了」；文案对两种情况都成立（「首次启动时这属正常；若这条对话本应存在，
  说明它的记录已被删除」）。
- **选中的对话已被别的条目绑走时必须模态确认**才继续。候选列表里照旧把它
  列出来（用户可能正是想改绑），标签上标「已绑给「X」」，但标签不够 ——
  实测这个用户 4 条条目共用同一个 cwd、列表里十几条长得很像，手滑选中别人
  的很现实。取消确认与按 Esc 同侧：什么都不启动，绑定不变。**两个入口都
  要过这道闸**：`openEntry` 的询问与显式命令「选择要接回的对话…」。

**`--resume` 失败必须看得见**：会话文件不在该 cwd 下时 claude 会打印
`No conversation found` 然后退出，pane 退回裸 shell。发完 `--resume` 后只读地
轮询 `capture-pane` 最多 2.5 s（**只看可视区域末尾 5 行**，见
`core/claude.ts#resumeFailed`；pane 更早的位置可能有用户自己 grep 过的同名
字串，只看底部才不误报），命中则报错并指向「选择要接回的对话…」。

**何时才允许发送**（唯一的闸门，见 §11 第 9 条）：`isShellReady(pane 前台进程)`。
会话刚建好、或 claude 已退出回到 shell → 发；claude 还在跑 → 只 attach。

### 15.5 性能：候选枚举必须并发

实测用户机器上 `~/.claude/projects` 有 31 个目录、292 个会话文件、合计 404 MB：

- 串行逐个 `open` + 读 64 KB 头部：**8.7 s**
- 并发（上限 32）：**43 ms**

串行会让「全部恢复」在弹出选择框之前先卡十几秒 —— 那本身就是用户抱怨的
那类体验。因此 `src/conversationFiles.ts` **只读文件头部**（首条用户消息实测
落在 ~20 KB 处，上限取 64 KB）并限并发读取；读不到摘要不影响候选可用
（时间 + 体积 + 目录足以辨认），但**读不出 cwd 的候选一律丢弃** —— 绝不猜归属。

### 15.6 交互：选择必须串行

「全部恢复」并行开 N 条条目。若各自弹一个 QuickPick，用户会同时看到一摞
对话框、分不清哪个属于哪个终端（实测用户 8 条条目里 7 条未绑定，首次恢复
会一次弹 7 个）。因此 `TerminalManager` 用一个 promise 链把选择交互串行化：
一次只弹一个，其余排队，标题始终带条目名。

### 15.7 改动清单

- 新增 `src/core/conversation.ts`（纯函数：头部解析、归属判据、候选排序、显示格式化）
- 新增 `src/conversationFiles.ts`（IO：限并发枚举会话文件）
- 新增 `src/core/command.ts#conversationCommand` 与 `LaunchSpec`
- 新增 `TerminalManager.resolveLaunchSpec` / `pickConversation` / `bindConversationInteractive`
- 新增命令 `tmuxTerminals.bindConversation`（「选择要接回的对话…」，可随时重新绑定）
- 条目 tooltip 显示绑定的对话（短 id）
- **删除 `src/core/plan.ts`**：它把「会话存活 → 不发命令」+`commandFor(entry)`
  （裸 claude，会开新对话顶掉原来的）写成了单一动作，语义已被这次订正取代；
  现在的闸门是 `core/tmux.ts#isShellReady`
- `TmuxClient.capturePane`（只读抓 pane 可视区域）+ `core/claude.ts#resumeFailed`
- `conversationFiles.ts#findConversations`（按 id 直查，判断该 `--session-id` 还是
  `--resume`）
