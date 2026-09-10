# VS Code 终端恢复器 — 设计文档

- 日期：2026-09-09
- 状态：已确认，待实现
- 项目路径：`mine/vscode-tmux-terminals`

## 1. 背景与问题

通过 VS Code Remote-SSH 工作。SSH 一断，Remote-SSH 会关掉所有集成终端标签，正在跑的进程随终端一起消失。重连后要手工重建每个终端、重新 `cd` 到各个工程目录、重新敲一遍启动命令。

痛点是**恢复成本**，不是终端本身消失（后者是 Remote-SSH 的既定行为，扩展无法阻止）。

## 2. 目标

1. 侧边栏维护一张「终端清单」，每条 = 名称 + 远端目录 + 预设命令。
2. 点击条目 → 一条龙恢复该终端。
3. 若远端 tmux 会话仍存活 → **接回原进程与滚动历史**，不重跑命令。
4. 条目可在侧边栏内直接增删改，不必手编配置文件。
5. 一键恢复全部标记过的条目。

## 3. 非目标（v1 明确不做）

- 多主机 / 跳板：条目不含「目标主机」字段，只作用于当前已连接的远端。
- 图形化表单（Webview）：用 VS Code 原生输入框。
- 会话分组、嵌套文件夹、清单导入导出。
- 阻止终端丢失（做不到）。
- 本地（非 Remote）场景的差异化支持：代码不排除本地，但不为其做额外适配。

## 4. 术语

| 词 | 含义 |
|---|---|
| 条目 | 清单里的一项：`{id, name, cwd, commands, autoRestore}` |
| 存活 | 远端存在同名 tmux 会话 |
| 接回 | `tmux attach` 到已存活会话 |
| 重建 | 新建终端 → 建 tmux 会话 → 执行预设命令 |

tmux 会话名**由条目 `id` 派生**：`sessionNameFor(id)` → `tmuxterm-<id>`。

> **实现后修订（2026-09-09）**：原设计是「条目 `name` 直接当 tmux 会话名」。
> 对抗性核验发现 tmux 允许会话名**含换行**，含换行的名字会让
> `tmux ls -F '#{session_name}'` 的一个会话占据两行，`parseSessionList`
> 便解析出一个不存在的幽灵会话；若其名恰等于某条目名，该条目会错误
> 显示为「存活」。
>
> 改为由 id 派生后从根上排除这类字符。连带好处：条目显示名不再受
> tmux 目标语法约束（`:`、`.`、纯数字都可以用了），校验只管显示用途
> —— 非空、不含换行、不重名。

## 5. 架构

### 5.1 运行位置（最关键的一条）

`package.json` 必须声明：

```json
"extensionKind": ["workspace"]
```

原因：扩展要调用**远端**的 `tmux`。若跑在本地（UI 侧），`execFile('tmux', ...)` 查的是本机 tmux，读到的存活状态、attach 的会话全是错的。`workspace` 强制扩展运行在远端 extension host。

副作用：扩展在每台远端各装一份，`globalStorageUri` 也各自独立 → **清单天然按机器隔离**，符合预期。

### 5.2 数据存放

`context.globalStorageUri` 下的 `terminals.json`（远端路径）。原子写：先写 `terminals.json.tmp` 再 `rename`，避免中途崩溃留半个文件。

不放入 `settings.json`：条目是数据不是配置，且要支持侧边栏增删改，写进用户设置会污染同步。

### 5.3 分层

```
src/
├── core/                 纯逻辑，零 vscode 依赖 → 100% 单元测试
│   ├── tmux.ts           parseSessionList / shellQuote / isShellCommand
│   ├── paths.ts          expandHome / validateName
│   └── plan.ts           planRestore ← **v2 已删除**，闸门现为 core/tmux.ts#isShellReady
├── tmuxClient.ts         execFile 包装：list / has / kill
├── store.ts              清单读写
├── tree.ts               TreeDataProvider + 存活状态
└── extension.ts          activate：注册命令 / 视图 / 轮询
```

**切分理由**：所有会出错的判断（解析 tmux 输出、shell 引用、决定 attach 还是 create）都是纯函数，脱离 VS Code 可测。VS Code 接线层薄到只剩 API 调用，手动冒烟即可。

## 6. 数据模型

```ts
interface TerminalEntry {
  id: string;            // 短随机串，重命名时不变
  name: string;          // 显示名 + tmux 会话名
  cwd: string;           // 远端路径，支持 ~
  commands: string[];    // 仅重建时执行
  autoRestore: boolean;  // 是否参与「全部恢复」
}
```

## 7. 核心逻辑契约（纯函数，TDD 覆盖）

### `parseSessionList(stdout: string): string[]`
- 输入 `"0\n1\n2\n"` → `["0","1","2"]`
- 输入 `""` 或 `"\n"` → `[]`（无会话时 tmux 的常见输出）
- 会话名含空格：逐行取整行，不按空格切分
- 不做 trim 以外的规范化

### `shellQuote(s: string): string`
- `paint-pc` → `'paint-pc'`
- `it's` → `'it'\''s'`
- 空串 → `''`
- 含 `$`、空格、中文一律按字面量保护（单引号内不做变量展开）

### `expandHome(p: string, home: string): string`
- `~` → `home`
- `~/mine` → `<home>/mine`
- `/abs/path` → 原样
- `~user/x` → 原样（不解析他人 home，交由 shell/系统报错）

### `validateName(name: string): string | null`
返回错误消息或 `null`。规则：
- 空 / 全空白 → 报错
- 含 `:` 或 `.` → 报错（tmux 目标语法 `session:window.pane` 会产生歧义）
- 纯数字 → 报错（与 tmux 的会话索引冲突）
- 与已有条目重名 → 报错

> **v2 已删除本节**（见 `2026-09-10-tmux-terminals-v2-design.md` §14/§15）。
> 判据不再是「会话是否存活」，而是「pane 前台是不是登录 shell」（`core/tmux.ts#isShellReady`）+ 条目绑定的对话（`core/restore.ts#decideOpen`、`core/command.ts#conversationCommand`）。以下为 v1 原文，保留作历史记录。

### `planRestore(entry, alive: boolean): { mode: 'attach'|'create', commands: string[] }`
- `alive === true` → `{ mode: 'attach', commands: [] }`
- `alive === false` → `{ mode: 'create', commands: entry.commands }`

**这条是安全闸门**：接回存活会话时 `commands` 必须为空，见 8.1。

## 8. 关键技术决策

### 8.1 预设命令只在「重建」时执行

若会话存活，attach 进去后**绝不能**再发命令。那会把 `source env.sh` 之类当成键盘输入送进你正在运行的进程的 stdin —— 想象往 `claude` 或一个编译进程里塞一行文本。

因此实现必须是 `has-session` 先分支，**不能用 `tmux new -A -s name` 一把梭**：`-A` 在会话已存在时会 attach，而代码无从得知，接着就会误发命令。

### 8.2 等 shell 就绪靠轮询，不靠固定 sleep

新建终端后立刻 `send-keys`，命令可能被中间的 bash（尚未被 tmux 接管 pty 时）吃掉或丢失。固定延时在慢机器上必然偶发失败。

做法：轮询 `tmux display-message -p -t <name> '#{pane_current_command}'`。

- 目标是**登录 shell**（`bash` / `zsh` / `sh` / `dash` / `fish`）→ 立即发送
- 轮询上限 ~3s
- 超时且命令名**不是** shell（例如用户 rc 自动 exec 了别的程序）→ **跳过命令并警告**，不硬塞。宁可少做，不可污染别人的 stdin。
- 已实测该 `#{pane_current_command}` 字段在无 TTY 的 `execFile` 下可正常返回。

### 8.3 展开 `~`

`createTerminal({ cwd })` 不认 `~/xxx`。扩展自己按远端 `os.homedir()` 展开，见 `expandHome`。

### 8.4 终端去重

同名终端已存在 → `terminal.show()` 复用，不新开。避免反复点击堆出一排同名终端。

### 8.5 create 分支的竞态兜底

`has-session` 判定为「不存在」后、`send-keys` 之前，会话理论上可能被别处建出来。发送前**再查一次** `has-session`：

- 仍不存在 → 发送 `tmux new -s <name>`
- 已存在 → 改发 `tmux attach -t <name>`，且跳过预设命令

### 8.6 命令注入的引用

`send-keys` 把文本原样送给 pty，需自己保证 shell 语义正确 —— 会话名与目录一律过 `shellQuote`。

### 8.7 无 tmux 时怎么执行预设命令

8.2 的「等 shell 就绪」依赖 tmux，无 tmux 时不可用。降级路径：

1. **优先用 VS Code Shell Integration API**：`terminal.shellIntegration?.executeCommand(cmd)`。不需要猜时机，VS Code 自己知道命令何时结束。需等 `shellIntegration` 就绪（`onDidChangeTerminalShellIntegration`），设超时。
2. **不可用时**回退 `sendText(cmd + '\n')`，先等 `onDidChangeTerminalShellIntegration` 或短暂延时。
3. 两条路都失败 → 直接把命令**打印**在终端里并提示用户手动执行，不静默吞掉。

注意：tmux 路径（8.2）不走这里 —— 在 tmux 里 shell integration 是否生效取决于配置，而 `#{pane_current_command}` 轮询已验证可靠，故两条路径各用各的机制。

## 9. 交互与命令

### 9.1 侧边栏

独立的活动栏容器（图标 + 标题「我的终端」），内含 TreeView：

```
 我的终端          [⟳ 全部恢复] [+ 新建] [↻ 刷新]
   🟢 paint-pc      ~/mine/paint-pc
   🟢 krita-build   ~/test
   ⚪ win-office    (无会话)
```

`⟳ 全部恢复` 与 `↻ 刷新` 是两回事：前者开终端，后者只重查存活状态。

- 🟢 会话存活，点击接回原进程
- ⚪ 会话不存在，点击新建并执行预设命令
- 图标随轮询刷新

### 9.2 命令清单

| 命令 ID | 触发 | 行为 |
|---|---|---|
| `tmuxTerminals.open` | 点条目 | 按 `planRestore` 分支 |
| `tmuxTerminals.add` | `+` | 依次输入 名称→目录→命令循环，留空结束 |
| `tmuxTerminals.edit` | 右键 | 同上，回车保留原值 |
| `tmuxTerminals.duplicate` | 右键 | 复制为新条目（id 新生成，`<原名>-copy`） |
| `tmuxTerminals.delete` | 右键 | 删条目，**不**动 tmux 会话 |
| `tmuxTerminals.killSession` | 右键 | `tmux kill-session`，模态确认 |
| `tmuxTerminals.toggleAutoRestore` | 右键 | 切换 `autoRestore` |
| `tmuxTerminals.restoreAll` | 顶部 `⟳` | 遍历 `autoRestore` 条目依次恢复 |
| `tmuxTerminals.refresh` | 视图标题 | 手动刷新存活状态 |

菜单项按上下文显隐：`killSession` 仅在存活时出现。

### 9.3 存活状态轮询

`tmux ls -F '#{session_name}'` 一次 `execFile` 拿全部会话名，与清单求交集。

- 仅在视图可见时轮询（`onDidChangeVisibility`）
- 间隔 `tmuxTerminals.pollInterval`，默认 10000ms
- 请求在途时跳过本轮，避免堆积
- 调用失败（无 tmux / 无会话）→ 全部视为不存在，不弹错

## 10. 边界与降级

| 情况 | 行为 |
|---|---|
| 远端无 tmux | 状态全灰；点击仍能开终端 + `cd` + **执行预设命令**（命令只需 shell，不依赖 tmux），但没有接回能力。首次检测到时提示一次 |
| 远端机器重启过 | 会话全没，全灰，点击变成重建 —— 符合预期 |
| tmux server 存在但零会话 | `tmux ls` 退出码非 0，视为空列表（必须容忍，不能当失败） |
| 清单为空 | 视图显示「点击 + 添加终端」的欢迎项 |
| `cwd` 不存在 | `createTerminal` 会失败 → 捕获后回退到 home 并警告 |
| 条目重名 | `validateName` 拦截 |

## 11. 测试策略

纯逻辑 TDD，节奏：先写失败测试 → 再实现。

覆盖：
- `parseSessionList`：空串 / 纯换行 / 尾换行 / 含空格名 / 多行
- `shellQuote`：普通 / 含单引号 / 含 `$` / 含空格 / 含中文 / 空串
- `expandHome`：`~` / `~/x` / `~user/x` / 绝对路径 / 相对路径
- `validateName`：空 / 含 `:` / 含 `.` / 纯数字 / 重名 / 合法
- `planRestore`：存活 → attach 且 commands 为空；不存在 → create 且带 commands

不下载 VS Code 做集成测试（`@vscode/test-electron` 需要图形环境，收益低）。VS Code 接线层走手动冒烟。

手动冒烟清单：
1. `+` 新建条目 → 出现在列表
2. 点击 ⚪ 条目 → 终端打开、在正确目录、tmux 会话建立、命令已执行
3. 圆点变 🟢
4. 在同一终端里 `Ctrl-C` 打断一个长命令 → 断开 SSH → 重连
5. 点 🟢 条目 → 接回，**原进程仍在**（关键验证）
6. 再点一次 → 复用已有终端，不新开
7. 杀掉 tmux 会话 → 圆点转 ⚪
8. 「全部恢复」→ 所有 `autoRestore` 条目拉起
9. 右键编辑 / 复制 / 删除 / 切换自动恢复

## 12. 打包与安装

- 依赖：`@types/vscode`、`typescript`、`mocha`、`@vscode/vsce`（`npx` 调用，不全局装）
- 打包：`npx @vscode/vsce package` → `.vsix`
- 安装：**必须先连上远端**，在远端窗口装 → 装进远端 extension host
- 验证：安装后确认 VS Code 把它归为 Workspace 类扩展，而非 UI 类

## 13. 风险

| 风险 | 应对 |
|---|---|
| 装错位置（装到本地） | `extensionKind: workspace`；安装步骤显式要求先连远端 |
| tmux 版本差异导致 `-F` 格式串不识别 | tmux ≥ 1.8 支持 `-F`；启动时用一次探测，失败则降级到解析 `tmux ls` 默认输出的前缀 |
| 用户 rc 自动 exec 程序导致无法执行预设命令 | 8.2 的超时跳过 + 警告，不污染 stdin |
| `globalStorageUri` 在远端重装后被清 | 清单文件路径可通过 `tmuxTerminals.storagePath` 覆盖，便于放到自选位置 |

## 14. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `tmuxTerminals.pollInterval` | `10000` | 状态轮询间隔（ms），0 关闭 |
| `tmuxTerminals.tmuxPath` | `tmux` | tmux 可执行文件路径 |
| `tmuxTerminals.storagePath` | `""` | 清单文件路径覆盖，空则用 `globalStorageUri` |

## 15. 未决 / 后续可加

- 多主机字段（v1 已明确排除，若日后需要则加 `host` 字段 + `ssh -t` 包裹）
- 条目排序 / 手动拖拽
- 面板显示每个会话的运行时长
