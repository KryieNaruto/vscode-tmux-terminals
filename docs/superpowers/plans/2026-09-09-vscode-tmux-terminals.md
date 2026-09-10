# vscode-tmux-terminals 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个 VS Code 扩展，在侧边栏维护一张「终端清单」，点击条目即可在 Remote-SSH 断线重连后一条龙恢复终端；若远端 tmux 会话仍存活则接回原进程与滚动历史。

**Architecture:** 扩展声明 `extensionKind: ["workspace"]` 强制运行在远端 extension host，从而能调用远端 `tmux`。所有判断逻辑（解析 tmux 输出、shell 引用、决定 attach 还是 create）提取为零 VS Code 依赖的纯函数放 `src/core/`，用 mocha 做 TDD；VS Code 接线层（TreeView、终端、命令）薄到只需手动冒烟。

**Tech Stack:** TypeScript、VS Code Extension API、Node `child_process.execFile`、tmux、mocha（测试）、`@vscode/vsce`（打包）

**Spec:** `docs/superpowers/specs/2026-09-09-vscode-tmux-terminals-design.md`

## Global Constraints

- `package.json` 必须含 `"extensionKind": ["workspace"]` —— 否则扩展跑在本地，调用的是本地 tmux，功能全错。
- **所有 tmux 目标必须精确匹配**：session 级命令用 `=name`，pane 级命令用 `=name:`。不加 `=` 会前缀匹配（实测 `has-session -t zzver` 能匹配 `zzverify`），会导致 attach 到错误会话、`kill-session` 误杀。- 见 Task 1/3。
- **预设命令只在「新建会话」分支执行**。会话存活时 attach，`commands` 必须为空数组，否则会把命令当键盘输入送进用户正在运行的进程 stdin。
- tmux 目标一律经 `sessionTarget()` / `paneTarget()` 生成，**不要**在别处手拼 `=` 和 `:`。
- **tmux 会话名一律经 `sessionNameFor(entry.id)` 派生**（形如 `tmuxterm-<id>`），**绝不用条目显示名**。tmux 允许会话名含换行，用显示名会让 `tmux ls -F` 输出错行、解析出幽灵会话。
- `execFile` 传 argv 数组不经过 shell → 传给 tmux 的参数**不做** shell 引用。`shellQuote()` 只用于「要塞进终端执行的命令行字符串」。
- 会话名规则：非空、不含 `:` 和 `.`、非纯数字、不与他条重名。
- 目标 VS Code ≥ 1.85。Node ≥ 18。

---

### Task 1: 项目脚手架 + tmux 核心纯函数

**Files:**
- Create: `package.json`
- Create: `package-lock.json`（由 `npm install` 生成，**必须提交**以固定依赖版本）
- Create: `tsconfig.json`
- Create: `.vscodeignore`
- Create: `src/core/tmux.ts`
- Test: `test/core/tmux.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `sessionTarget(name: string): string` → `"=name"`
  - `paneTarget(name: string): string` → `"=name:"`
  - `parseSessionList(stdout: string): string[]`
  - `shellQuote(s: string): string`
  - `isShellReady(currentCommand: string): boolean`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "vscode-tmux-terminals",
  "displayName": "Tmux Terminals",
  "description": "一键恢复 Remote-SSH 断开后的终端工作区",
  "version": "0.1.0",
  "publisher": "KryieNaruto",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/KryieNaruto/vscode-tmux-terminals.git" },
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "extensionKind": ["workspace"],
  "main": "./out/extension.js",
  "activationEvents": [],
  "contributes": {},
  "scripts": {
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "test": "npm run compile && mocha out/test/**/*.test.js",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/mocha": "^10.0.6",
    "@types/node": "^20.11.0",
    "@types/vscode": "^1.85.0",
    "@vscode/vsce": "^2.22.0",
    "mocha": "^10.3.0",
    "typescript": "^5.3.3"
  }
}
```

- [ ] **Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "out",
    "rootDir": ".",
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: 写 .vscodeignore**

```
.vscode/**
src/**
test/**
docs/**
node_modules/**
out/test/**
**/*.map
tsconfig.json
```

- [ ] **Step 4: 装依赖**

Run: `npm install`
Expected: 生成 `node_modules/`，无报错。

- [ ] **Step 5: 写失败测试**

创建 `test/core/tmux.test.ts`：

```ts
import * as assert from 'assert';
import { sessionTarget, paneTarget, parseSessionList, shellQuote, isShellReady } from '../../src/core/tmux';

describe('sessionTarget / paneTarget', () => {
  it('session 目标加 = 前缀强制精确匹配', () => {
    assert.strictEqual(sessionTarget('build'), '=build');
  });
  it('pane 目标加 = 前缀且带冒号', () => {
    assert.strictEqual(paneTarget('build'), '=build:');
  });
  it('名字里有空格也照样处理', () => {
    assert.strictEqual(sessionTarget('my build'), '=my build');
    assert.strictEqual(paneTarget('my build'), '=my build:');
  });
});

describe('parseSessionList', () => {
  it('解析常规多行输出', () => {
    assert.deepStrictEqual(parseSessionList('0\n1\n2\n'), ['0', '1', '2']);
  });
  it('空输出返回空数组', () => {
    assert.deepStrictEqual(parseSessionList(''), []);
  });
  it('只有换行也返回空数组', () => {
    assert.deepStrictEqual(parseSessionList('\n'), []);
  });
  it('保留含空格的会话名为整行', () => {
    assert.deepStrictEqual(parseSessionList('my build\nother\n'), ['my build', 'other']);
  });
  it('忽略多余空白行', () => {
    assert.deepStrictEqual(parseSessionList('a\n\n\nb\n'), ['a', 'b']);
  });
  it('去掉行尾回车（CRLF 容忍）', () => {
    assert.deepStrictEqual(parseSessionList('a\r\nb\r\n'), ['a', 'b']);
  });
});

describe('shellQuote', () => {
  it('普通字符串包一层单引号', () => {
    assert.strictEqual(shellQuote('paint-pc'), "'paint-pc'");
  });
  it('单引号被正确转义', () => {
    assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
  });
  it('美元符被保护', () => {
    assert.strictEqual(shellQuote('$HOME'), "'$HOME'");
  });
  it('空格被保护', () => {
    assert.strictEqual(shellQuote('a b'), "'a b'");
  });
  it('中文被保护', () => {
    assert.strictEqual(shellQuote('中文 名'), "'中文 名'");
  });
  it('空串得到一对空单引号', () => {
    assert.strictEqual(shellQuote(''), "''");
  });
  it('反引号被保护', () => {
    assert.strictEqual(shellQuote('x`y'), "'x`y'");
  });
});

describe('isShellReady', () => {
  it('识别常见登录 shell', () => {
    for (const s of ['bash', 'zsh', 'sh', 'dash', 'fish']) {
      assert.strictEqual(isShellReady(s), true, s);
    }
  });
  it('识别带前导横杠的登录 shell（-bash）', () => {
    assert.strictEqual(isShellReady('-bash'), true);
  });
  it('识别带路径的 shell', () => {
    assert.strictEqual(isShellReady('/bin/bash'), true);
    assert.strictEqual(isShellReady('/usr/bin/zsh'), true);
  });
  it('把空串判为未就绪（关键：display-message 目标写错会静默返回空）', () => {
    assert.strictEqual(isShellReady(''), false);
    assert.strictEqual(isShellReady('   '), false);
  });
  it('把非 shell 前台进程判为未就绪', () => {
    assert.strictEqual(isShellReady('sleep'), false);
    assert.strictEqual(isShellReady('claude'), false);
    assert.strictEqual(isShellReady('vim'), false);
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `npm test`
Expected: 编译失败，`Cannot find module '../../src/core/tmux'`。

- [ ] **Step 7: 写实现**

创建 `src/core/tmux.ts`：

```ts
/**
 * tmux 相关的纯函数。
 *
 * 本文件刻意不依赖 vscode，以便脱离编辑器直接单测。
 *
 * 背景（实测结论，勿改）：
 * - tmux 的目标名默认做「前缀匹配」。若存在会话 `build-android`，
 *   则 `-t build` 会命中它。这会导致 attach 到错误会话、甚至
 *   `kill-session` 误杀用户正在跑的东西。因此所有目标都必须加 `=`
 *   前缀强制精确匹配。
 * - session 级命令（has-session / kill-session）用 `=name`。
 * - pane 级命令（send-keys / capture-pane / display-message）必须写
 *   `=name:`，缺冒号会失败 —— 且 display-message 失败方式是
 *   **exit 0 + 空输出**，静默无声，极难排查。
 */

/** session 级目标，用于 has-session / kill-session */
export function sessionTarget(name: string): string {
  return `=${name}`;
}

/** pane 级目标，用于 send-keys / capture-pane / display-message */
export function paneTarget(name: string): string {
  return `=${name}:`;
}

/** 解析 `tmux ls -F '#{session_name}'` 的输出 */
export function parseSessionList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * POSIX 单引号 shell 引用。
 * 单引号内一切字符都是字面量，唯一需要处理的是单引号本身：
 * 先关引号、插入一个转义单引号、再开引号。
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const LOGIN_SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'tcsh', 'csh']);

/**
 * 判断 tmux pane 的前台进程是否是登录 shell —— 即「会话已就绪，
 * 可以安全 send-keys」。
 *
 * 空串必须判为未就绪：那是 display-message 目标写错时的返回值，
 * 若当成就绪会一路静默跳过所有预设命令。
 */
export function isShellReady(currentCommand: string): boolean {
  const cmd = currentCommand.trim();
  if (cmd.length === 0) return false;
  const base = cmd.split('/').pop() ?? cmd;
  return LOGIN_SHELLS.has(base.replace(/^-/, ''));
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npm test`
Expected: 全部 PASS（约 20 个断言）。

- [ ] **Step 9: 提交**

```bash
git add package.json package-lock.json tsconfig.json .vscodeignore src/core/tmux.ts test/core/tmux.test.ts
git commit -m "feat: 项目脚手架 + tmux 纯函数（精确目标/解析/引用/就绪判断）"
```

---

### Task 2: 路径与条目名校验

**Files:**
- Create: `src/core/paths.ts`
- Test: `test/core/paths.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `expandHome(p: string, home: string): string`
  - `validateName(name: string, existingNames: string[]): string | null`（返回错误消息或 `null` 表示通过）

- [ ] **Step 1: 写失败测试**

创建 `test/core/paths.test.ts`：

```ts
import * as assert from 'assert';
import { expandHome, validateName } from '../../src/core/paths';

describe('expandHome', () => {
  const home = '/home/qiansenwei';
  it('单独的 ~ 展开为 home', () => {
    assert.strictEqual(expandHome('~', home), home);
  });
  it('~/x 展开为 home/x', () => {
    assert.strictEqual(expandHome('~/mine', home), '/home/qiansenwei/mine');
  });
  it('绝对路径原样返回', () => {
    assert.strictEqual(expandHome('/ssd/work', home), '/ssd/work');
  });
  it('相对路径原样返回', () => {
    assert.strictEqual(expandHome('mine/paint', home), 'mine/paint');
  });
  it('~user/x 原样返回（不解析他人 home）', () => {
    assert.strictEqual(expandHome('~other/x', home), '~other/x');
  });
  it('空串原样返回', () => {
    assert.strictEqual(expandHome('', home), '');
  });
  it('不误伤以 ~ 开头但非家目录的路径', () => {
    assert.strictEqual(expandHome('~abc', home), '~abc');
  });
});

describe('validateName', () => {
  const existing = ['paint-pc', 'krita-build'];

  it('合法名通过', () => {
    assert.strictEqual(validateName('new-one', existing), null);
  });
  it('空名报错', () => {
    assert.notStrictEqual(validateName('', existing), null);
  });
  it('全空白报错', () => {
    assert.notStrictEqual(validateName('   ', existing), null);
  });
  it('含冒号报错（与 tmux 的 session:window.pane 目标语法冲突）', () => {
    assert.notStrictEqual(validateName('a:b', existing), null);
  });
  it('含点号报错（同上）', () => {
    assert.notStrictEqual(validateName('a.b', existing), null);
  });
  it('纯数字报错（与 tmux 会话索引冲突）', () => {
    assert.notStrictEqual(validateName('123', existing), null);
  });
  it('与已有条目重名报错', () => {
    assert.notStrictEqual(validateName('paint-pc', existing), null);
  });
  it('重名判断区分大小写', () => {
    assert.strictEqual(validateName('PAINT-PC', existing), null);
  });
  it('名字两侧空白被忽略后再判重', () => {
    assert.notStrictEqual(validateName('  paint-pc  ', existing), null);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: 编译失败，找不到 `src/core/paths`。

- [ ] **Step 3: 写实现**

创建 `src/core/paths.ts`：

```ts
/** 路径与条目名校验的纯函数。不依赖 vscode。 */

/**
 * 展开开头的 `~`。
 *
 * 必须自己做：`vscode.window.createTerminal({ cwd })` 不认 `~/xxx`。
 * 只处理 `~` 和 `~/`，不从 `~user/` 里解析别人的 home —— tmux/系统
 * 会自己报错，扩展不该猜。
 */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p;
}

/**
 * 校验条目名。返回错误消息，或 null 表示通过。
 *
 * 名字同时用作 tmux 会话名，所以限制来自 tmux：
 * - `:` 和 `.` 是 tmux 目标的层级分隔符（session:window.pane），会造成歧义
 * - 纯数字与 tmux 的会话索引（0、1、2…）冲突
 */
export function validateName(name: string, existingNames: string[]): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '名称不能为空';
  if (trimmed.includes(':')) return '名称不能包含冒号（与 tmux 目标语法冲突）';
  if (trimmed.includes('.')) return '名称不能包含点号（与 tmux 目标语法冲突）';
  if (/^\d+$/.test(trimmed)) return '名称不能是纯数字（与 tmux 会话索引冲突）';
  if (existingNames.includes(trimmed)) return `名称「${trimmed}」已存在`;
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/paths.ts test/core/paths.test.ts
git commit -m "feat: 路径展开与条目名校验"
```

---

### Task 3: 恢复决策 planRestore

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/plan.ts`
- Test: `test/core/plan.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface TerminalEntry { id: string; name: string; cwd: string; commands: string[]; autoRestore: boolean }`
  - `type RestoreMode = 'attach' | 'create'`
  - `interface RestorePlan { mode: RestoreMode; commands: string[] }`
  - `planRestore(entry: TerminalEntry, alive: boolean): RestorePlan`

- [ ] **Step 1: 写失败测试**

创建 `test/core/plan.test.ts`：

```ts
import * as assert from 'assert';
import { planRestore } from '../../src/core/plan';
import { TerminalEntry } from '../../src/core/types';

const entry: TerminalEntry = {
  id: 'a1',
  name: 'paint-pc',
  cwd: '~/mine/paint-pc',
  commands: ['source env.sh', 'ls'],
  autoRestore: true,
};

describe('planRestore', () => {
  it('会话存活 → attach，且命令必须为空', () => {
    const plan = planRestore(entry, true);
    assert.strictEqual(plan.mode, 'attach');
    assert.deepStrictEqual(plan.commands, []);
  });

  it('会话存活时绝不带命令（防止把命令塞进运行中进程的 stdin）', () => {
    const plan = planRestore({ ...entry, commands: ['rm -rf /tmp/x'] }, true);
    assert.strictEqual(plan.commands.length, 0);
  });

  it('会话不存在 → create，并带上全部预设命令', () => {
    const plan = planRestore(entry, false);
    assert.strictEqual(plan.mode, 'create');
    assert.deepStrictEqual(plan.commands, ['source env.sh', 'ls']);
  });

  it('create 时返回的是副本，改动不影响原条目', () => {
    const plan = planRestore(entry, false);
    plan.commands.push('mutated');
    assert.deepStrictEqual(entry.commands, ['source env.sh', 'ls']);
  });

  it('无预设命令时 create 返回空数组', () => {
    const plan = planRestore({ ...entry, commands: [] }, false);
    assert.strictEqual(plan.mode, 'create');
    assert.deepStrictEqual(plan.commands, []);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: 编译失败，找不到 `../../src/core/plan`。

- [ ] **Step 3: 写实现**

创建 `src/core/types.ts`：

```ts
/** 侧边栏的一个终端条目。 */
export interface TerminalEntry {
  /** 短随机串，重命名时保持不变。**tmux 会话名由它派生** */
  id: string;
  /** 显示名。不再是 tmux 会话名，见 core/tmux.ts 的 sessionNameFor */
  name: string;
  /** 远端路径，支持 ~ */
  cwd: string;
  /** 仅在「新建会话」时执行 */
  commands: string[];
  /** 是否参与「全部恢复」 */
  autoRestore: boolean;
}
```

> **实现后修订（2026-09-09）**：原设计是「条目 name 直接当 tmux 会话名」。
> 对抗性核验发现 tmux 允许会话名含换行，会让 `tmux ls -F` 的一个会话
> 占两行、解析出幽灵会话。现改为**会话名由 id 派生**（`sessionNameFor(id)`
> → `tmuxterm-<id>`），从根上排除；`escapeSessionName()` 作纵深防御。
> 连带影响：`validateName` 解禁 `:`、`.`、纯数字（显示名不再进 tmux
> 目标语法），仍拦换行与重名。

创建 `src/core/plan.ts`：

```ts
import { TerminalEntry } from './types';

export type RestoreMode = 'attach' | 'create';

export interface RestorePlan {
  mode: RestoreMode;
  commands: string[];
}

/**
 * 决定点击条目时该 attach 还是 create。
 *
 * **这是本项目的安全闸门。** 会话存活时必须 attach 且命令为空：
 * 若在存活会话上执行预设命令，那些命令会作为键盘输入进入用户正在
 * 运行的进程的 stdin（例如往一个跑着的 claude、编译或 REPL 里塞一
 * 行 `source env.sh`），后果不可预料。
 *
 * 因此不要用 `tmux new -A -s name` 一把梭 —— `-A` 在会话已存在时会
 * attach，调用方无从得知，接着就会误发命令。
 */
export function planRestore(entry: TerminalEntry, alive: boolean): RestorePlan {
  if (alive) {
    return { mode: 'attach', commands: [] };
  }
  return { mode: 'create', commands: [...entry.commands] };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/types.ts src/core/plan.ts test/core/plan.test.ts
git commit -m "feat: 恢复决策 planRestore（存活即 attach 且不带命令）"
```

---

### Task 4: 清单存储 store

**Files:**
- Create: `src/core/store.ts`
- Test: `test/core/store.test.ts`

**Interfaces:**
- Consumes: `TerminalEntry`（Task 3）
- Produces:
  - `class EntryStore`
    - `constructor(filePath: string)`
    - `async load(): Promise<TerminalEntry[]>`
    - `async save(entries: TerminalEntry[]): Promise<void>`
    - `async add(entry: TerminalEntry): Promise<void>`
    - `async update(id: string, patch: Partial<TerminalEntry>): Promise<void>`
    - `async remove(id: string): Promise<void>`
    - `async findByName(name: string): Promise<TerminalEntry | undefined>`
  - `newId(): string`

- [ ] **Step 1: 写失败测试**

创建 `test/core/store.test.ts`：

```ts
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EntryStore, newId } from '../../src/core/store';
import { TerminalEntry } from '../../src/core/types';

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxterm-')), 'terminals.json');
}

const entry = (over: Partial<TerminalEntry> = {}): TerminalEntry => ({
  id: newId(),
  name: 'paint-pc',
  cwd: '~/mine/paint-pc',
  commands: ['source env.sh'],
  autoRestore: true,
  ...over,
});

describe('EntryStore', () => {
  it('文件不存在时返回空数组，不抛错', async () => {
    const store = new EntryStore(tmpFile());
    assert.deepStrictEqual(await store.load(), []);
  });

  it('保存后再读取内容一致', async () => {
    const store = new EntryStore(tmpFile());
    const e = entry();
    await store.save([e]);
    assert.deepStrictEqual(await store.load(), [e]);
  });

  it('写入是原子的：不留下 .tmp 残留', async () => {
    const file = tmpFile();
    const store = new EntryStore(file);
    await store.save([entry()]);
    assert.strictEqual(fs.existsSync(file + '.tmp'), false);
  });

  it('损坏的 JSON 不抛错，返回空数组', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{ this is not json');
    const store = new EntryStore(file);
    assert.deepStrictEqual(await store.load(), []);
  });

  it('内容不是数组时返回空数组', async () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{"a":1}');
    const store = new EntryStore(file);
    assert.deepStrictEqual(await store.load(), []);
  });

  it('自动创建父目录', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxterm-')), 'a', 'b', 'terminals.json');
    const store = new EntryStore(file);
    await store.save([entry()]);
    assert.strictEqual(fs.existsSync(file), true);
  });

  it('add 追加条目', async () => {
    const store = new EntryStore(tmpFile());
    await store.add(entry({ name: 'one' }));
    await store.add(entry({ name: 'two' }));
    const all = await store.load();
    assert.deepStrictEqual(all.map((e) => e.name), ['one', 'two']);
  });

  it('update 只改指定字段', async () => {
    const store = new EntryStore(tmpFile());
    const e = entry();
    await store.add(e);
    await store.update(e.id, { cwd: '/new/path' });
    const [got] = await store.load();
    assert.strictEqual(got.cwd, '/new/path');
    assert.strictEqual(got.name, 'paint-pc');
    assert.strictEqual(got.id, e.id);
  });

  it('remove 按 id 删除', async () => {
    const store = new EntryStore(tmpFile());
    const a = entry({ name: 'a' });
    const b = entry({ name: 'b' });
    await store.add(a);
    await store.add(b);
    await store.remove(a.id);
    const all = await store.load();
    assert.deepStrictEqual(all.map((e) => e.name), ['b']);
  });

  it('findByName 找得到也找得空', async () => {
    const store = new EntryStore(tmpFile());
    await store.add(entry({ name: 'target' }));
    assert.strictEqual((await store.findByName('target'))?.name, 'target');
    assert.strictEqual(await store.findByName('nope'), undefined);
  });

  it('newId 生成不重复的 id', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    assert.strictEqual(ids.size, 500);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: 编译失败，找不到 `src/core/store`。

- [ ] **Step 3: 写实现**

创建 `src/core/store.ts`：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/store.ts test/core/store.test.ts
git commit -m "feat: 条目清单存储（原子写、损坏容错）"
```

---

### Task 5: tmux 客户端（execFile 封装）

**Files:**
- Create: `src/tmuxClient.ts`
- Test: `test/tmuxClient.integration.test.ts`

**Interfaces:**
- Consumes: `sessionTarget` / `paneTarget` / `parseSessionList` / `isShellReady`（Task 1）
- Produces:
  - `class TmuxClient`
    - `constructor(tmuxPath: string)`
    - `async listSessions(): Promise<string[]>`（失败/无会话返回 `[]`）
    - `async hasSession(name: string): Promise<boolean>`
    - `async newSession(name: string, cwd: string): Promise<boolean>`（**返回 `false` 表示会话已存在**，即被人抢先建了）
    - `async killSession(name: string): Promise<void>`
    - `async currentCommand(name: string): Promise<string>`
    - `async sendLiteral(name: string, text: string): Promise<void>`
    - `async sendEnter(name: string): Promise<void>`
    - `async waitForShell(name: string, timeoutMs: number): Promise<boolean>`

**说明：** 本任务是唯一带「真跑 tmux」集成测试的，因为这里正是坑最多的地方（精确匹配、pane 目标、静默空输出）。测试会建/删带 `zztest-` 前缀的临时会话，不碰用户既有会话。

- [ ] **Step 1: 写失败测试**

创建 `test/tmuxClient.integration.test.ts`：

```ts
import * as assert from 'assert';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { TmuxClient } from '../src/tmuxClient';

const run = promisify(execFile);
const client = new TmuxClient('tmux');
const A = 'zztest-alpha';
const B = 'zztest-alphabeta'; // 用来验证 A 不会前缀匹配到 B

async function cleanup() {
  for (const n of [A, B]) {
    try { await run('tmux', ['kill-session', '-t', `=${n}`]); } catch { /* 不存在就算了 */ }
  }
}

describe('TmuxClient（集成，需要本机有 tmux）', function () {
  this.timeout(20000);

  before(async () => {
    await cleanup();
  });

  after(async () => {
    await cleanup();
  });

  it('无会话时 listSessions 返回数组且不含临时会话', async () => {
    const list = await client.listSessions();
    assert.ok(Array.isArray(list));
    assert.ok(!list.includes(A));
  });

  it('hasSession 对不存在的会话返回 false', async () => {
    assert.strictEqual(await client.hasSession(A), false);
  });

  it('建会话后 hasSession 返回 true，listSessions 能列出', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.hasSession(A), true);
    assert.ok((await client.listSessions()).includes(A));
  });

  it('关键：hasSession 不做前缀匹配（A 存在时 A+后缀 仍为 false）', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.hasSession(B), false);
  });

  it('newSession 成功建会话并返回 true', async () => {
    assert.strictEqual(await client.newSession(A, '/tmp'), true);
    assert.strictEqual(await client.hasSession(A), true);
  });

  it('newSession 在会话已存在时返回 false（不抛错，供竞态判断用）', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.newSession(A, '/tmp'), false);
  });

  it('newSession 的 cwd 生效（新会话默认目录为指定路径）', async () => {
    await client.newSession(A, '/tmp');
    await client.waitForShell(A, 3000);
    const { stdout } = await run('tmux', ['display-message', '-p', '-t', `=${A}:`, '#{pane_current_path}']);
    // /tmp 可能是符号链接，用 realpath 比对
    const real = await import('fs/promises').then((f) => f.realpath('/tmp'));
    assert.strictEqual(stdout.trim(), real);
  });

  it('currentCommand 对就绪会话返回 bash（验证 pane 目标带冒号）', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    const cmd = await client.currentCommand(A);
    assert.notStrictEqual(cmd.trim(), '', '返回空说明 pane 目标写错了');
    assert.strictEqual(cmd.trim(), 'bash');
  });

  it('waitForShell 对就绪会话返回 true', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.waitForShell(A, 3000), true);
  });

  it('waitForShell 对不存在的会话在超时后返回 false', async () => {
    const t0 = Date.now();
    assert.strictEqual(await client.waitForShell('zztest-does-not-exist', 600), false);
    assert.ok(Date.now() - t0 >= 500, '应真的等到超时');
  });

  it('sendLiteral + sendEnter 能把命令送进会话并执行', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.waitForShell(A, 3000), true);
    await client.sendLiteral(A, 'echo SENTINEL_XYZ');
    await client.sendEnter(A);
    await new Promise((r) => setTimeout(r, 400));
    const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', `=${A}:`]);
    assert.ok(stdout.includes('SENTINEL_XYZ'), `会话里没看到命令输出:\n${stdout}`);
  });

  it('sendLiteral 是字面量模式，特殊字符不被 shell 之外的层解释', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    assert.strictEqual(await client.waitForShell(A, 3000), true);
    await client.sendLiteral(A, 'echo "quoted $HOME"');
    await client.sendEnter(A);
    await new Promise((r) => setTimeout(r, 400));
    const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', `=${A}:`]);
    assert.ok(stdout.includes('quoted'), `字面量发送失败:\n${stdout}`);
  });

  it('killSession 删掉会话，且不误杀前缀相同的另一个会话', async () => {
    await run('tmux', ['new-session', '-d', '-s', A]);
    await run('tmux', ['new-session', '-d', '-s', B]);
    await client.killSession(A);
    assert.strictEqual(await client.hasSession(A), false);
    assert.strictEqual(await client.hasSession(B), true, '前缀相同的会话被误杀了');
  });

  it('killSession 对不存在的会话不抛错', async () => {
    await client.killSession('zztest-never-existed');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: 编译失败，找不到 `../src/tmuxClient`。

- [ ] **Step 3: 写实现**

创建 `src/tmuxClient.ts`：

```ts
import { execFile } from 'child_process';
import { promisify } from 'util';
import { paneTarget, parseSessionList, sessionTarget, isShellReady } from './core/tmux';

const run = promisify(execFile);

/**
 * tmux 的薄封装。
 *
 * 所有目标都经 sessionTarget()/paneTarget() 生成，见 core/tmux.ts 里
 * 关于前缀匹配与 pane 目标的说明 —— 那是本项目踩过的两个坑。
 *
 * execFile 传 argv 数组，不经过 shell，所以这里的参数不需要 shell
 * 引用。shellQuote() 只用于「要塞进终端执行的命令行字符串」。
 */
export class TmuxClient {
  constructor(private readonly tmuxPath: string = 'tmux') {}

  /** 列出所有会话名。tmux 无会话时退出码非 0，属正常，返回空数组。 */
  async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await run(this.tmuxPath, ['ls', '-F', '#{session_name}']);
      return parseSessionList(stdout);
    } catch {
      return [];
    }
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await run(this.tmuxPath, ['has-session', '-t', sessionTarget(name)]);
      return true;
    } catch {
      return false;
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await run(this.tmuxPath, ['kill-session', '-t', sessionTarget(name)]);
    } catch {
      // 会话本就不存在 —— 目标状态已达成，不算失败
    }
  }

  /**
   * 以 detached 方式建会话，返回是否真的由本次调用创建。
   *
   * **为什么不直接在终端里 `tmux new -s name`：** 那样无法区分
   * 「我建成功了」和「别人抢先建了」。若被别人抢先，`tmux new` 会
   * 失败（exit 1），但随后 waitForShell 会看到「会话存在且是 shell」
   * 而判定就绪 —— 于是预设命令被发进**别人的**会话，污染对方 stdin。
   *
   * 从 execFile 建则能拿到确定的 exit code：已存在时 tmux 报
   * "duplicate session" 并以非 0 退出，据此返回 false，调用方转为
   * attach 模式且不执行任何命令。
   *
   * detached 创建后，终端只负责 `tmux attach`，规避了整个竞态。
   */
  async newSession(name: string, cwd: string): Promise<boolean> {
    try {
      await run(this.tmuxPath, ['new-session', '-d', '-s', name, '-c', cwd]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 取 pane 的前台进程名。
   *
   * 注意 pane 目标必须带冒号；写错时 tmux 返回 exit 0 + 空串，
   * 不报错，所以这里把空串原样返回，由 isShellReady() 判为未就绪。
   */
  async currentCommand(name: string): Promise<string> {
    try {
      const { stdout } = await run(this.tmuxPath, [
        'display-message', '-p', '-t', paneTarget(name), '#{pane_current_command}',
      ]);
      return stdout.trim();
    } catch {
      return '';
    }
  }

  /** 以字面量模式发送文本（不解释键名，也不做 shell 引用）。 */
  async sendLiteral(name: string, text: string): Promise<void> {
    await run(this.tmuxPath, ['send-keys', '-l', '-t', paneTarget(name), text]);
  }

  async sendEnter(name: string): Promise<void> {
    await run(this.tmuxPath, ['send-keys', '-t', paneTarget(name), 'Enter']);
  }

  /**
   * 等会话的 shell 就绪（可以安全 send-keys）。
   *
   * 用轮询而非固定 sleep：固定延时不保证正确，慢机器上必然偶发失败。
   * 超时返回 false，调用方据此跳过预设命令 —— 宁可少做，也不能把
   * 命令塞进一个还没就绪或已被别的程序占用的 pane。
   */
  async waitForShell(name: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (isShellReady(await this.currentCommand(name))) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: 全部 PASS。确认结束时 `tmux ls` 里没有 `zztest-` 残留：

```bash
tmux ls -F '#{session_name}' | grep -c zztest || echo "无残留 ✓"
```

- [ ] **Step 5: 提交**

```bash
git add src/tmuxClient.ts test/tmuxClient.integration.test.ts
git commit -m "feat: tmux 客户端封装 + 精确匹配/前缀误杀集成测试"
```

---

### Task 6: package.json 贡献点（视图、命令、菜单、配置）

**Files:**
- Modify: `package.json`（`contributes` 与 `activationEvents`）

**Interfaces:**
- Consumes: 无
- Produces: 供 Task 7/8 注册用的命令 ID 与视图 ID：
  - 视图容器 `tmuxTerminals`，视图 `tmuxTerminals.list`
  - 命令：`tmuxTerminals.open` / `.add` / `.edit` / `.duplicate` / `.delete` / `.killSession` / `.toggleAutoRestore` / `.restoreAll` / `.refresh`
  - 配置：`tmuxTerminals.pollInterval` / `.tmuxPath` / `.storagePath`

- [ ] **Step 1: 替换 package.json 的 contributes 段**

把 `"contributes": {}` 替换为：

```json
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "tmuxTerminals",
          "title": "我的终端",
          "icon": "resources/terminal.svg"
        }
      ]
    },
    "views": {
      "tmuxTerminals": [
        {
          "id": "tmuxTerminals.list",
          "name": "终端清单"
        }
      ]
    },
    "commands": [
      { "command": "tmuxTerminals.open", "title": "打开终端", "icon": "$(terminal)" },
      { "command": "tmuxTerminals.add", "title": "新建终端条目", "icon": "$(add)" },
      { "command": "tmuxTerminals.edit", "title": "编辑", "icon": "$(edit)" },
      { "command": "tmuxTerminals.duplicate", "title": "复制", "icon": "$(copy)" },
      { "command": "tmuxTerminals.delete", "title": "删除条目", "icon": "$(trash)" },
      { "command": "tmuxTerminals.killSession", "title": "杀掉远端 tmux 会话", "icon": "$(stop-circle)" },
      { "command": "tmuxTerminals.toggleAutoRestore", "title": "切换「参与全部恢复」", "icon": "$(check)" },
      { "command": "tmuxTerminals.restoreAll", "title": "全部恢复", "icon": "$(history)" },
      { "command": "tmuxTerminals.refresh", "title": "刷新状态", "icon": "$(refresh)" }
    ],
    "menus": {
      "view/title": [
        { "command": "tmuxTerminals.restoreAll", "when": "view == tmuxTerminals.list", "group": "navigation@1" },
        { "command": "tmuxTerminals.add", "when": "view == tmuxTerminals.list", "group": "navigation@2" },
        { "command": "tmuxTerminals.refresh", "when": "view == tmuxTerminals.list", "group": "navigation@3" }
      ],
      "view/item/context": [
        { "command": "tmuxTerminals.open", "when": "view == tmuxTerminals.list", "group": "inline@1" },
        { "command": "tmuxTerminals.killSession", "when": "view == tmuxTerminals.list && viewItem == aliveSession", "group": "1_kill@1" },
        { "command": "tmuxTerminals.edit", "when": "view == tmuxTerminals.list", "group": "2_edit@1" },
        { "command": "tmuxTerminals.duplicate", "when": "view == tmuxTerminals.list", "group": "2_edit@2" },
        { "command": "tmuxTerminals.toggleAutoRestore", "when": "view == tmuxTerminals.list", "group": "2_edit@3" },
        { "command": "tmuxTerminals.delete", "when": "view == tmuxTerminals.list", "group": "3_danger@1" }
      ]
    },
    "configuration": {
      "title": "Tmux Terminals",
      "properties": {
        "tmuxTerminals.pollInterval": {
          "type": "number",
          "default": 10000,
          "markdownDescription": "存活状态轮询间隔（毫秒）。设为 `0` 关闭轮询。"
        },
        "tmuxTerminals.tmuxPath": {
          "type": "string",
          "default": "tmux",
          "markdownDescription": "tmux 可执行文件路径。不在 PATH 里时填绝对路径。"
        },
        "tmuxTerminals.storagePath": {
          "type": "string",
          "default": "",
          "markdownDescription": "条目清单文件路径。留空则使用扩展的远端存储目录。重装扩展会清空该目录，需要长期保留时请指定一个固定路径。"
        }
      }
    }
  },
```

- [ ] **Step 2: 加 activationEvents**

把 `"activationEvents": []` 替换为：

```json
  "activationEvents": ["onView:tmuxTerminals.list"],
```

- [ ] **Step 3: 加图标**

创建 `resources/terminal.svg`：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor">
  <path d="M2 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H2zm0 1h12v10H2V3z"/>
  <path d="M4.146 5.146a.5.5 0 0 1 .708 0L7 7.293l-2.146 2.146a.5.5 0 0 1-.708-.707L5.293 7.5 4.146 6.354a.5.5 0 0 1 0-.708z"/>
  <path d="M7.5 9.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1H8a.5.5 0 0 1-.5-.5z"/>
</svg>
```

- [ ] **Step 4: 验证清单合法**

Run: `npx @vscode/vsce ls`
Expected: 列出将被打包的文件，无 manifest 校验错误。

- [ ] **Step 5: 提交**

```bash
git add package.json resources/terminal.svg
git commit -m "feat: 侧边栏视图、命令、右键菜单与配置项"
```

---

### Task 7: TreeView 数据提供者

**Files:**
- Create: `src/tree.ts`
- Create: `src/terminalManager.ts`
- Create: `src/extension.ts`

**Interfaces:**
- Consumes: `EntryStore`（Task 4）、`TmuxClient`（Task 5）、`TerminalEntry`（Task 3）、Task 6 的视图与命令 ID
- Produces:
  - `class EntryTreeItem extends vscode.TreeItem`（`contextValue` 为 `aliveSession` 或 `deadSession`）
  - `class EntryTreeProvider implements vscode.TreeDataProvider<EntryTreeItem>`
    - `constructor(store, tmux, getPollInterval: () => number)`
    - `refresh(): void`
    - `setAlive(names: Set<string>): void`
  - `class TerminalManager`
    - `constructor(store: EntryStore, tmux: TmuxClient)`
    - `openEntry(entry: TerminalEntry): Promise<void>`
    - `restoreAll(): Promise<void>`
    - `addEntryInteractive(): Promise<void>`
    - `editEntryInteractive(entry): Promise<void>`
    - `duplicateEntry(entry): Promise<void>`
    - `deleteEntry(entry): Promise<void>`
    - `killSession(entry): Promise<void>`
    - `toggleAutoRestore(entry): Promise<void>`

- [ ] **Step 1: 写 tree.ts**

```ts
import * as vscode from 'vscode';
import { TerminalEntry } from './core/types';

/**
 * 清单里的一行。
 *
 * `contextValue` 决定右键菜单显隐：`killSession` 只在存活时出现，
 * 见 package.json 里 `viewItem == aliveSession` 的 when 条件。
 */
export class EntryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: TerminalEntry,
    public readonly alive: boolean,
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.id = entry.id;
    this.contextValue = alive ? 'aliveSession' : 'deadSession';
    this.description = alive ? entry.cwd : `${entry.cwd}（无会话）`;
    this.tooltip = new vscode.MarkdownString(
      [
        `**${entry.name}**`,
        '',
        `- 目录：\`${entry.cwd}\``,
        `- 状态：${alive ? '🟢 会话存活，点击接回原进程' : '⚪ 无会话，点击新建并执行预设命令'}`,
        `- 预设命令：${entry.commands.length === 0 ? '（无）' : ''}`,
        ...entry.commands.map((c) => `  - \`${c}\``),
        `- 参与全部恢复：${entry.autoRestore ? '是' : '否'}`,
      ].join('\n'),
    );
    this.iconPath = new vscode.ThemeIcon(
      alive ? 'circle-filled' : 'circle-outline',
      alive ? new vscode.ThemeColor('terminal.ansiGreen') : undefined,
    );
    this.command = {
      command: 'tmuxTerminals.open',
      title: '打开终端',
      arguments: [this],
    };
  }
}

/** 清单为空时显示的一行，点击即新建。 */
export class EmptyTreeItem extends vscode.TreeItem {
  constructor() {
    super('点击 + 添加一个终端条目', vscode.TreeItemCollapsibleState.None);
    this.command = { command: 'tmuxTerminals.add', title: '新建终端条目' };
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'empty';
  }
}

export type TreeNode = EntryTreeItem | EmptyTreeItem;

export class EntryTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private entries: TerminalEntry[] = [];
  private alive = new Set<string>();

  constructor(
    private readonly store: { load(): Promise<TerminalEntry[]> },
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  setAlive(names: Set<string>): void {
    const changed =
      names.size !== this.alive.size || [...names].some((n) => !this.alive.has(n));
    this.alive = names;
    if (changed) this.emitter.fire();
  }

  isAlive(name: string): boolean {
    return this.alive.has(name);
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (element) return [];
    this.entries = await this.store.load();
    if (this.entries.length === 0) return [new EmptyTreeItem()];
    return this.entries.map((e) => new EntryTreeItem(e, this.alive.has(e.name)));
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }
}
```

- [ ] **Step 2: 写 terminalManager.ts**

```ts
import * as os from 'os';
import * as vscode from 'vscode';
import { expandHome, validateName } from './core/paths';
import { planRestore } from './core/plan';
import { shellQuote } from './core/tmux';
import { TerminalEntry } from './core/types';
import { EntryStore, newId } from './core/store';
import { TmuxClient } from './tmuxClient';

const SHELL_READY_TIMEOUT_MS = 3000;

export class TerminalManager {
  /** 会话名 → 终端，用于去重：重复点击复用已有终端而不是新开。 */
  private readonly terminals = new Map<string, vscode.Terminal>();

  constructor(
    private readonly store: EntryStore,
    private readonly tmux: TmuxClient,
  ) {
    vscode.window.onDidCloseTerminal((t) => {
      for (const [name, term] of this.terminals) {
        if (term === t) this.terminals.delete(name);
      }
    });
  }

  private home(): string {
    // 扩展跑在远端，os.homedir() 即远端家目录
    return os.homedir();
  }

  private cwdFor(entry: TerminalEntry): string {
    return expandHome(entry.cwd, this.home());
  }

  /**
   * 打开（接回或重建）一个条目。
   *
   * 不变量：竞态兜底**只能把命令降级为空，永远不能凭空加出命令**。
   * 任何「会话可能已属于别人」的迹象都必须导致 `runCommands = false`。
   */
  async openEntry(entry: TerminalEntry): Promise<void> {
    const existing = this.terminals.get(entry.name);
    if (existing) {
      existing.show();
      return;
    }

    const cwd = this.cwdFor(entry);
    const wasAlive = await this.tmux.hasSession(entry.name);

    // 会话不存在时由扩展 detached 建出来，拿到确定的成功/失败信号。
    let runCommands = false;
    if (!wasAlive) {
      if (await this.tmux.newSession(entry.name, cwd)) {
        runCommands = true;
      } else if (await this.tmux.hasSession(entry.name)) {
        // 竞态：等待期间被别的窗口建出来了 → 转为接回，绝不发命令
        vscode.window.showInformationMessage(
          `会话「${entry.name}」刚被其他窗口创建，改为接回，不执行预设命令。`,
        );
      } else {
        // 真的建不出来（tmux 不可用、cwd 不存在等）
        const t = vscode.window.createTerminal({ name: entry.name });
        this.terminals.set(entry.name, t);
        t.show();
        vscode.window.showErrorMessage(
          `无法创建 tmux 会话「${entry.name}」。已打开普通终端，请检查 tmux 是否可用、目录是否存在：${cwd}`,
        );
        return;
      }
    }

    // planRestore 仍是命令清单的唯一来源；runCommands 只能把它清空
    const plan = planRestore(entry, wasAlive);
    const commands = runCommands ? plan.commands : [];

    let terminal: vscode.Terminal;
    try {
      terminal = vscode.window.createTerminal({ name: entry.name, cwd });
    } catch {
      vscode.window.showWarningMessage(`目录不存在，已在主目录打开：${cwd}`);
      terminal = vscode.window.createTerminal({ name: entry.name });
    }
    this.terminals.set(entry.name, terminal);
    terminal.show();

    // 此刻会话必定存在（原本存活、刚建成功、或被抢先建出），一律 attach。
    // 命令行字符串要塞进 shell 执行，故此处需要 shell 引用。
    terminal.sendText(`tmux attach -t ${shellQuote('=' + entry.name)}`, true);

    if (commands.length === 0) return;

    const ready = await this.tmux.waitForShell(entry.name, SHELL_READY_TIMEOUT_MS);
    if (!ready) {
      vscode.window.showWarningMessage(
        `tmux 会话「${entry.name}」未在 ${SHELL_READY_TIMEOUT_MS / 1000}s 内就绪，已跳过 ${commands.length} 条预设命令。`,
      );
      return;
    }
    for (const c of commands) {
      await this.tmux.sendLiteral(entry.name, c);
      await this.tmux.sendEnter(entry.name);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async restoreAll(): Promise<void> {
    const entries = (await this.store.load()).filter((e) => e.autoRestore);
    if (entries.length === 0) {
      vscode.window.showInformationMessage('没有标记为「参与全部恢复」的条目。');
      return;
    }
    for (const e of entries) {
      await this.openEntry(e);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // ---- 交互式增删改 ----

  async addEntryInteractive(): Promise<void> {
    const all = await this.store.load();
    const name = await this.askName([], all.map((e) => e.name));
    if (!name) return;
    const cwd = await this.askCwd();
    if (cwd === undefined) return;
    const commands = await this.askCommands([]);
    if (commands === undefined) return;
    const autoRestore = await this.askAutoRestore(true);
    if (autoRestore === undefined) return;

    await this.store.add({ id: newId(), name, cwd, commands, autoRestore });
  }

  async editEntryInteractive(entry: TerminalEntry): Promise<void> {
    const all = await this.store.load();
    const others = all.filter((e) => e.id !== entry.id).map((e) => e.name);

    const name = await this.askName(entry.name, others);
    if (!name) return;
    const cwd = await this.askCwd(entry.cwd);
    if (cwd === undefined) return;
    const commands = await this.askCommands(entry.commands);
    if (commands === undefined) return;

    await this.store.update(entry.id, { name, cwd, commands });
  }

  async duplicateEntry(entry: TerminalEntry): Promise<void> {
    const all = await this.store.load();
    const base = `${entry.name}-copy`;
    let name = base;
    let n = 2;
    while (all.some((e) => e.name === name)) {
      name = `${base}${n++}`;
    }
    await this.store.add({ ...entry, id: newId(), name });
  }

  async deleteEntry(entry: TerminalEntry): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `删除条目「${entry.name}」？远端 tmux 会话不受影响。`,
      { modal: true },
      '删除',
    );
    if (pick !== '删除') return;
    await this.store.remove(entry.id);
  }

  async killSession(entry: TerminalEntry): Promise<void> {
    const pick = await vscode.window.showWarningMessage(
      `杀掉远端 tmux 会话「${entry.name}」？其中正在运行的进程会一并终止。`,
      { modal: true },
      '杀掉',
    );
    if (pick !== '杀掉') return;
    await this.tmux.killSession(entry.name);
    vscode.window.showInformationMessage(`已杀掉会话「${entry.name}」。`);
  }

  async toggleAutoRestore(entry: TerminalEntry): Promise<void> {
    await this.store.update(entry.id, { autoRestore: !entry.autoRestore });
  }

  // ---- 输入辅助 ----

  private async askName(
    current: string,
    existingNames: string[],
  ): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      title: '终端名称',
      prompt: '同时用作 tmux 会话名',
      value: current,
      validateInput: (v) => validateName(v, existingNames),
    });
    return value === undefined ? undefined : value.trim();
  }

  private async askCwd(current?: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: '远程目录',
      prompt: '支持 ~ 开头，例如 ~/mine/paint-pc',
      value: current ?? '',
      validateInput: (v) => (v.trim().length === 0 ? '目录不能为空' : null),
    });
  }

  /** 循环输入命令，留空结束。返回 undefined 表示用户中途取消。 */
  private async askCommands(current: string[]): Promise<string[] | undefined> {
    const result = [...current];
    const first = current.length === 0;
    let editing = first;
    while (editing) {
      const v = await vscode.window.showInputBox({
        title: first ? '命令 1（可留空跳过）' : `命令 ${result.length + 1}（留空结束）`,
        prompt: '仅在新建 tmux 会话时执行；会话存活接回时不执行',
        value: '',
        ignoreFocusOut: true,
      });
      if (v === undefined) return undefined; // 用户按 Esc 取消整个流程
      if (v.trim().length === 0) break;
      result.push(v);
      editing = true;
    }
    return result;
  }

  private async askAutoRestore(def: boolean): Promise<boolean | undefined> {
    const pick = await vscode.window.showQuickPick(
      ['是', '否'],
      { title: '是否参与「全部恢复」？', placeHolder: def ? '是' : '否' },
    );
    if (pick === undefined) return undefined;
    return pick === '是';
  }
}
```

- [ ] **Step 3: 写 extension.ts**

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import { EntryStore } from './core/store';
import { TmuxClient } from './tmuxClient';
import { EntryTreeItem, EntryTreeProvider } from './tree';
import { TerminalManager } from './terminalManager';

let pollTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration('tmuxTerminals');

  const storageFile = (): string => {
    const override = cfg().get<string>('storagePath', '').trim();
    return override.length > 0
      ? override
      : path.join(context.globalStorageUri.fsPath, 'terminals.json');
  };

  const tmux = new TmuxClient(cfg().get<string>('tmuxPath', 'tmux'));
  const store = new EntryStore(storageFile());
  const provider = new EntryTreeProvider(store);
  const manager = new TerminalManager(store, tmux);

  const view = vscode.window.createTreeView('tmuxTerminals.list', {
    treeDataProvider: provider,
  });
  context.subscriptions.push(view);

  // ---- 存活状态轮询 ----
  let inFlight = false;
  const poll = async () => {
    if (inFlight) return; // 上一轮还没回来就跳过，避免请求堆积
    inFlight = true;
    try {
      provider.setAlive(new Set(await tmux.listSessions()));
    } finally {
      inFlight = false;
    }
  };

  const restartPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    const interval = cfg().get<number>('pollInterval', 10000);
    if (interval > 0 && view.visible) {
      pollTimer = setInterval(() => void poll(), interval);
    }
    void poll();
  };

  context.subscriptions.push(
    view.onDidChangeVisibility(() => restartPolling()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tmuxTerminals')) restartPolling();
    }),
    new vscode.Disposable(() => {
      if (pollTimer) clearInterval(pollTimer);
    }),
  );
  restartPolling();

  // ---- 命令注册 ----
  const item = (arg: unknown): EntryTreeItem | undefined =>
    arg instanceof EntryTreeItem ? arg : undefined;

  const reg = (id: string, fn: (...a: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('tmuxTerminals.open', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.openEntry(it.entry);
  });

  reg('tmuxTerminals.add', async () => {
    await manager.addEntryInteractive();
    provider.refresh();
  });

  reg('tmuxTerminals.edit', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.editEntryInteractive(it.entry);
    provider.refresh();
  });

  reg('tmuxTerminals.duplicate', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.duplicateEntry(it.entry);
    provider.refresh();
  });

  reg('tmuxTerminals.delete', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.deleteEntry(it.entry);
    provider.refresh();
  });

  reg('tmuxTerminals.killSession', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.killSession(it.entry);
    await poll();
  });

  reg('tmuxTerminals.toggleAutoRestore', async (arg: unknown) => {
    const it = item(arg);
    if (it) await manager.toggleAutoRestore(it.entry);
    provider.refresh();
  });

  reg('tmuxTerminals.restoreAll', async () => {
    await manager.restoreAll();
    await poll();
  });

  reg('tmuxTerminals.refresh', async () => {
    await poll();
    provider.refresh();
  });
}

export function deactivate(): void {
  if (pollTimer) clearInterval(pollTimer);
}
```

- [ ] **Step 4: 编译**

Run: `npm run compile`
Expected: 无 TypeScript 错误。若报 `EntryTreeItem` 未导出，检查 tree.ts 的 export。

- [ ] **Step 5: 确认纯逻辑测试仍全绿**

Run: `npm test`
Expected: 全部 PASS（接线层改动不影响 core）。

- [ ] **Step 6: 提交**

```bash
git add src/tree.ts src/terminalManager.ts src/extension.ts
git commit -m "feat: 侧边栏树、终端管理器与命令接线"
```

---

### Task 8: README、打包与端到端冒烟

**Files:**
- Create: `README.md`
- Create: `docs/smoke-test.md`

**Interfaces:**
- Consumes: 前 7 个任务的全部产出
- Produces: 可安装的 `.vsix`

- [ ] **Step 1: 写 README.md**

创建 `README.md`：

````markdown
# Tmux Terminals

一键恢复 Remote-SSH 断开后的终端工作区。

## 解决什么问题

用 VS Code Remote-SSH 时，连接一断，所有集成终端标签连同里面正在
跑的进程一起消失。重连后要手工重建每个终端、重新 `cd` 到各个工程
目录、重新敲一遍启动命令。

这个扩展在侧边栏维护一张终端清单。点一下，终端就回来了；如果远端
的 tmux 会话还活着，连**正在跑的进程和滚动历史**也一起接回来。

## 三个概念

- **条目**：一条记录，含 名称 / 远程目录 / 预设命令。名称同时用作
  tmux 会话名。
- **存活**：远端存在同名 tmux 会话。
- **接回**：附到已存活的会话上，进程和历史都还在。

## 安装

需要在**已连接到远端**的 VS Code 窗口里安装，扩展才会装到远端。

```bash
npx @vscode/vsce package
```

然后在远端窗口的扩展面板里选择「从 VSIX 安装」。

> 本扩展声明了 `extensionKind: workspace`，必须运行在远端才能调用
> 远端的 tmux。装在本地是无效的。

## 使用

| 操作 | 效果 |
|---|---|
| 标题栏 `+` | 新建条目（依次输入 名称 → 目录 → 命令，命令留空结束） |
| 点击条目 | 🟢 接回原进程；⚪ 新建会话并执行预设命令 |
| 标题栏 ⟳ | 恢复所有标记了「参与全部恢复」的条目 |
| 标题栏 ↻ | 只重查存活状态，不开终端 |
| 右键条目 | 编辑 / 复制 / 切换自动恢复 / 删除条目 / 杀掉远端会话 |

## 重要：预设命令只在「新建会话」时执行

会话还活着时，点击是**接回**，预设命令**不会**执行。

这是刻意的：如果往一个正在运行的会话里发命令，那行命令会作为键盘
输入进入你正在跑的进程（比如一个 claude、一个编译、一个 REPL），
后果不可预料。

想重新跑一遍预设命令，先右键「杀掉远端 tmux 会话」，再点击条目。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `tmuxTerminals.pollInterval` | `10000` | 存活状态轮询间隔（ms），`0` 关闭 |
| `tmuxTerminals.tmuxPath` | `tmux` | tmux 可执行文件路径 |
| `tmuxTerminals.storagePath` | `""` | 清单文件路径。留空用扩展存储目录，**重装扩展会清空** |

## 已知限制

- 条目按远端机器隔离（扩展在每台远端各存一份清单）。
- 远端没装 tmux 时仍能开终端并 `cd`，但没有接回能力。
- 远端机器重启过则所有 tmux 会话消失，所有条目会显示为 ⚪。

## 开发

```bash
npm install
npm test          # 纯逻辑单测 + tmux 集成测试
npm run compile
```

按 F5 启动 Extension Development Host 调试。

## License

MIT
````

- [ ] **Step 2: 写 docs/smoke-test.md**

创建 `docs/smoke-test.md`：

````markdown
# 手动冒烟清单

纯逻辑层有单测覆盖，但 VS Code 接线层没有自动化测试。装好后请逐条
走一遍。

## 准备

在一个**已连接远端**的 VS Code 窗口里装好 `.vsix`，重载窗口。

## 清单

- [ ] 侧边栏出现「我的终端」图标，点开显示空清单与「点击 + 添加」
- [ ] 点 `+`，依次输入 名称 `smoke-a`、目录 `~`、命令 `echo HELLO`
- [ ] 侧边栏出现 `smoke-a`，圆点为 ⚪，描述显示目录 + 「无会话」
- [ ] 点击该条目 → 终端打开、位于家目录、tmux 会话建立、
      终端里能看到 `HELLO` 的输出
- [ ] 圆点变为 🟢
- [ ] 再点一次该条目 → 复用已有终端，不新开
- [ ] **核心验证**：在该终端里运行 `sleep 600`，然后断开 SSH →
      重连 → 点 🟢 条目 → 接回后 `sleep 600` **仍在运行**
      （用 `Ctrl-C` 打断它验证确实是同一个进程）
- [ ] 右键该条目 → 「杀掉远端 tmux 会话」→ 确认 → 圆点转 ⚪
- [ ] 再次点击 → 重新建立会话，`HELLO` 再次出现（预设命令应重跑，
      因为这次是新建）
- [ ] **前缀安全**：建两个条目 `smoke-b` 和 `smoke-b-long`，都打开。
      杀掉 `smoke-b`，确认 `smoke-b-long` 仍为 🟢（验证精确匹配，
      没有被前缀误杀）
- [ ] **全部恢复**：删除 `smoke-b-long`，右键 `smoke-a` 与 `smoke-b`
      确认参与全部恢复，点标题栏 ⟳ → 两个终端都被拉起
- [ ] 右键条目 → 编辑 → 改目录 → 点开确认新目录生效
- [ ] 右键条目 → 复制 → 出现 `smoke-a-copy`
- [ ] 右键条目 → 删除条目 → 确认 → 条目消失，
      但 tmux 会话仍在（`tmux ls` 里还能看到）
- [ ] **无 tmux 降级**（可选）：把 `tmuxTerminals.tmuxPath` 改成一个
      不存在的路径 → 所有圆点变 ⚪，点击仍能开终端并 `cd` 到目录

## 清理

```bash
tmux ls -F '#{session_name}' | grep '^smoke-' | xargs -r -I{} tmux kill-session -t '={}'
```
````

- [ ] **Step 3: 打包**

Run: `npx @vscode/vsce package`
Expected: 生成 `vscode-tmux-terminals-0.1.0.vsix`，无错误。

- [ ] **Step 4: 装到远端并冒烟**

在**已连接远端**的 VS Code 窗口里安装该 `.vsix`，然后逐条走 `docs/smoke-test.md`。

关键验证项（必须全部通过才算完成）：

- [ ] 新建条目 → 侧边栏出现该行
- [ ] 点击 ⚪ 条目 → 终端打开、位于正确目录、tmux 会话建立、预设命令已执行
- [ ] 圆点变 🟢
- [ ] 在该终端跑一个长命令 → 断开 SSH → 重连
- [ ] 点 🟢 条目 → **接回后原进程仍在**（本项目的核心价值）
- [ ] 再点一次 → 复用已有终端，不新开
- [ ] 杀掉 tmux 会话 → 圆点转 ⚪
- [ ] 「全部恢复」拉起所有 `autoRestore` 条目
- [ ] 两个名字互为前缀的条目（如 `build` / `build-android`）→ 状态互不干扰，杀掉一个另一个仍在

- [ ] **Step 5: 提交并推送**

```bash
git add README.md docs/smoke-test.md
git commit -m "docs: README 与手动冒烟清单"
```

推送见 Task 9。

---

### Task 9: 推送到 GitHub

**Files:**
- 无（仓库操作）

**Files:**
- Create: `mine/vscode-tmux-terminals/.claude/settings.json`

**Interfaces:**
- Consumes: 全部提交
- Produces: `https://github.com/KryieNaruto/vscode-tmux-terminals`

**安全前提（务必遵守）：** 本机 `credential.helper = store` 会把凭据**明文**写进 `~/.git-credentials`。因此**不要**让 git 把 token 存下来。下面用一次性内联 credential helper，从环境变量读取凭据，磁盘不留痕。

- [ ] **Step 1: 确认远端仓库是否存在**

Run:
```bash
GH_TOKEN="$GH_TOKEN" gh repo view KryieNaruto/vscode-tmux-terminals 2>&1 | head -3
```
若不存在则创建（`--public` 已确认）：

```bash
GH_TOKEN="$GH_TOKEN" gh repo create KryieNaruto/vscode-tmux-terminals \
  --public \
  --description "一键恢复 Remote-SSH 断开后的终端工作区" \
  --source . --remote origin --push
```

- [ ] **Step 2: 绑定远端**

Run: `git remote add origin https://github.com/KryieNaruto/vscode-tmux-terminals.git`
（若已存在则 `git remote set-url origin ...`）

- [ ] **Step 3: 推送（不落盘凭据）**

Run:
```bash
GH_TOKEN="$GH_TOKEN" git \
  -c credential.helper='!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f' \
  push -u origin main
```
Expected: 推送成功，输出包含 `main -> main`。

- [ ] **Step 4: 确认凭据未落盘**

Run: `grep -c 'ghp_' ~/.git-credentials 2>/dev/null || echo "0 —— 未落盘 ✓"`
Expected: `0 —— 未落盘 ✓`

- [ ] **Step 5: 确认远端内容**

Run:
```bash
GH_TOKEN="$GH_TOKEN" gh repo view KryieNaruto/vscode-tmux-terminals --json url,visibility,defaultBranchRef
```
Expected: `visibility: PUBLIC`，默认分支 `main`。

- [ ] **Step 6: 提醒用户吊销 token**

推送完成后必须明确告知用户：去 GitHub → Settings → Developer settings → Personal access tokens **吊销本次使用的 token**（它已出现在对话记录中，且权限包含 `delete_repo` / `admin:org`）。吊销不会影响已推送的代码。
