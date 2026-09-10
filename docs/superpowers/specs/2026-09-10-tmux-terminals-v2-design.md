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
  3. `~` 下的直接子目录
  4. `~/workspace` 下的直接子目录
- 仅列**一层**，避免扫描开销；输入框仍支持 `~` 展开
- 候选目录个数上限（如 50），超出截断并在提示里说明

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

## 11. 不变量清单（实施与测试必须守住）

1. 竞态兜底**只能把命令降级为空，永远不能凭空加出命令**（v1 原文，继续有效）
2. 控制序列只在「会话存活且前端确认是 claude」时发送，否则拒绝并说明
3. 任何"会话可能属于别人"的迹象 → 一律不发送
4. 拖拽重排只改本地顺序，绝不触发 tmux 操作
5. 迁移不得丢失用户已有条目；改写前先备份
6. `=<名字>:` 必须带冒号（`=` 精确匹配 + pane 级目标）

## 12. 验证方式

- **纯函数层**（`src/core/`）：`commandFor`、`migrate`、短路径消歧、`planRestore` 的现有测试 —— TDD，先写失败测试
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
