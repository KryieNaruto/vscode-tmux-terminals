# 多会话（v0.2.0）实施计划

```
REPO=/ssd/qiansenwei/workspace/mine/vscode-tmux-terminals
SPEC=/ssd/qiansenwei/workspace/mine/vscode-tmux-terminals/docs/superpowers/specs/2026-09-16-multi-session-design.md
```

**实施前必读**：SPEC 全文（尤其 §3.2 的两条待复核判断、§11 不变量清单、§12 测试计划）。
本文件只讲「怎么做、按什么顺序、怎么算做完」；**任何「为什么」都在 SPEC 里**，
两者冲突时以 SPEC 为准并回报。

**基线（2026-09-16 实测，本机）**：`npm test` → **401 passing**；
`npm run e2e` → 全绿。tmux 3.4、node v24.14.0、npm 11.19.0。
**任何 Task 结束时 `npm test` 必须全绿且用例数只增不减**（除 SPEC §12.2 明确
列出要改写的那些文件）。基线数 401 是后面每个 Task 的对照锚点。

---

## Global Constraints

逐条都要能在代码/产物里找到落点。verifier 会逐条对照。

1. **只改 `REPO` 内的文件。不 push、不打 tag** —— 发布是 Task 7 的事。
2. **`src/core/*.ts` 保持零 vscode 依赖、零 IO**（SPEC §11.14）。新增的
   `core/sessions.ts` / `core/colors.ts` / `core/selection.ts` 必须能脱离
   编辑器 mocha 单测；vscode / fs 相关一律放 `src/colorIcons.ts` 这类非 core 文件。
3. **一个 Task 一次提交**，提交信息用本文件给的那条。只 `git add` 该 Task
   涉及的文件，**不要 `git add -A`**。
4. **绝不为了让测试变绿而删断言、放宽断言、加 `|| true`、`.skip`、`only`。**
   因数据模型变化必须改的断言，改得**有判别力**（改个变量名就挂的不算数）。
   SPEC §12.2 里点名「预期不改」的测试文件，如果实现需要动它，**停下回报**。
5. **绝不删除任何既有命令 ID**（`killSession` 保留，只见 SPEC §3.3 第 4 条收窄语义）。
6. **迁移无损**：v1/v2 合成出的槽，**`id` 必须等于原条目 id**（SPEC §11.1）。
7. **槽级改写一律走 `store.updateSession` / `addSession` / `removeSession`**，
   绝不「load → 改数组 → update」（SPEC §11.5）。
8. **不改这五个文件的语义**：`core/reconcile.ts`（一个字符都不改）、
   `core/restore.ts`、`core/activity.ts`、`core/command.ts`、`core/grouping.ts`。
   它们只在**类型层**跟随（若因类型收紧需要动，只动类型，不动逻辑与注释）。
9. **`.gitignore` / `.vscodeignore` 现有规则不动**（`*.vsix` 仍被忽略）。
10. 注释与新增 JSDoc 一律**中文**，并沿用本仓库的写法：**写「为什么」而不是
    「做了什么」**，尤其要写下「写错会怎样」。这是本仓库最显眼的既有风格，
    新增代码必须匹配。改动既有代码时，**被改那几行的原有注释要么保留、
    要么按新事实改写，不许留着与代码不符的旧注释**。

---

## Task 1 — 数据模型切到 v3（原子变更，**行为一个字都不许变**）

**这一步是整个迭代的承重墙。** 它只做一件事：把「一条目 = 一会话」换成
「一条目 = 会话槽数组」，并且让**所有既有行为保持原样**（每个条目恰好 1 个
槽，界面与命令一律不变）。新功能全部留给 Task 2 之后。

之所以必须原子：`TerminalEntry` 去掉 `conversationId` 会让全仓库编译不过，
没有「中间能编译的状态」可停。

### 文件

**新增**
- `src/core/sessions.ts`
- `src/core/colors.ts`
- `src/core/selection.ts`
- `test/core/sessions.test.ts`
- `test/core/colors.test.ts`
- `test/core/selection.test.ts`

**改写/扩展**
- `src/core/types.ts`（SPEC §4.1 / §4.2）
- `src/core/migrate.ts`（SPEC §5.1 / §5.2）
- `src/core/store.ts`（SPEC §5.3 / §5.4 / §10）
- `test/core/migrate.test.ts`、`test/core/store.test.ts`
- `src/terminalManager.ts`（机械跟随，见下）
- `src/tree.ts`（只改读 `conversationId` 的那几处）
- `test/e2e-harness.js`（机械跟随，见下）

**不动**：`src/batchTree.ts`、`src/extension.ts`（两者都不直接读
`conversationId` / `liveSessionId`，应当**零改动**编译通过 —— 若发现必须动，
停下回报）。

### 步骤

1. **TDD：先写三个新纯函数模块的测试**（SPEC §12.1 逐条），确认**全红**。
   然后实现：
   - `core/sessions.ts`：`sortSessions`、`nextSessionOrder`（SPEC §4.3）
   - `core/colors.ts`：`PRESET_COLORS`（8 色）、`normalizeHexColor`、
     `colorBarSvg`（SPEC §6.4）
   - `core/selection.ts`：`folderSelectionState`、`toggleFolderSelection`（SPEC §9.2）
2. `core/types.ts`：加 `SessionSlot`，`TerminalEntry` 加 `sessions: SessionSlot[]`
   与 `color?: string`，**删掉** `conversationId` / `liveSessionId`
   （SPEC §4.2 的 JSDoc 原样落进代码）。`SessionSlot` 的 JSDoc 必须包含
   「v1/v2 迁移时槽 id 等于原条目 id，以及为什么」这一段（SPEC §4.1）。
3. `core/migrate.ts`：三形态（SPEC §5.1）。导出 `isV2Shape`。**这一步的测试
   先写**（SPEC §12.2 的 migrate 行逐条）。
4. `core/store.ts`：
   - `load()` 里对每条条目跑 `sortSessions`（SPEC §5.3）
   - 新增 `updateSession` / `addSession` / `removeSession`（SPEC §10，
     **`id` 钉死原值**）
   - 新增 `migrateAndBackupV2()`（SPEC §5.4），**`migrateAndBackup()` 一字不改**
5. **全仓库机械跟随**（这一步最量大，规则只有两条，**逐处照做、不许顺手改行为**）：
   - 每一处读/写 `entry.conversationId` → 读/写 `entry.sessions[0].conversationId`
   - 每一处读/写 `entry.liveSessionId` → 读/写 `entry.sessions[0].liveSessionId`
   - 每一处 `sessionNameFor(entry.id)` → `sessionNameFor(entry.sessions[0].id)`
   - `store.update(id, { conversationId })` → `store.updateSession(id, id, { conversationId })`
     （此时每个条目的槽 id 恒等于条目 id）
   - 回写用**不可变**写法：`store.updateSession` 内部合并，调用方不要自己拼数组
   - `tree.ts` 的 `conversationLabel(entry)` → 接收 `SessionSlot`；
     `taskNameFor(entry)` 的 `peek` 入参改成槽的 `conversationId`
   - `entry.sessions` 可能为空（`sessions[0]` 是 `undefined`）：**空槽数组的
     条目一律「什么都不做」**（不打开、不观测、不回写），不要 `!` 断言、
     不要编造一个槽。加一处防御并在注释里写明理由。
6. `test/e2e-harness.js` 机械跟随（**只改调用形式，断言一行都不许动**）：
   - `mk(...)` 改成 SPEC §12.4 的写法（`conversationId`/`liveSessionId`
     **只进槽**、槽 id 取 `id`）
   - `fresh(id).conversationId` → `fresh(id).sessions[0].conversationId`
     （含 `bound(id)` 辅助、以及所有直接读 `.conversationId` 的断言与 `chk`）
   - `store.update(ID, { conversationId: X })` → `store.updateSession(ID, ID, { conversationId: X })`
   - `m.openEntry(e)` / `m.openEntry(e, opts)` → `m.openSession(e, e.sessions[0])` /
     `m.openSession(e, e.sessions[0], opts)` —— **本 Task 里 `openEntry` 改名为
     `openSession(entry, slot, opts?)`，签名多一个 `slot`，内部一律用 `slot`
     取代原来的 `entry`**（SPEC §8 第 1、3 点）
   - **不要**在这个 Task 里给 stub 加 `Uri`（Task 3 才需要）

### Expected

- `npm test` 全绿，**用例数 ≥ 401**（新增三个模块的用例；migrate/store 的
  用例按 SPEC §12.2 扩展）。贴出最后一行 `N passing`。
- `npm run e2e` 全绿（与基线一致，**用例数不减**）—— 这是「行为没变」的
  主证据。
- `grep -rn "conversationId" src/core/types.ts` → **只出现在 `SessionSlot` 里**
  （`TerminalEntry` 上不应有）。
- `grep -rn "entry\.conversationId\|entry\.liveSessionId" src/` → **无输出**。
- `git diff --stat` 里 **`src/batchTree.ts` / `src/extension.ts` 不在列表里**。
- 空槽数组的防御真的在：`grep -n "sessions.length === 0\|sessions\[0\]" src/terminalManager.ts`
  能看到「空槽不动作」的分支。

### 提交

```
refactor: 数据模型切到 v3（一条目挂会话槽），行为不变

TerminalEntry 的 conversationId / liveSessionId 下移到新的 sessions[]
里，每条目恰好一个槽（槽 id = 条目 id，与 v1 起的 tmuxterm-<id>
会话名规则一致）。v2 清单由此无损迁移，正在跑的会话仍认得出。

同时补齐 v3 缺的三块纯函数：会话排序、颜色归一化、批量面板三态选中。
本提交刻意不含任何新行为 —— 界面、命令、语义与 0.1.8 逐字相同，
e2e harness 与 401 条单测是这一次「没改坏」的证据。
```

---

## Task 2 — `TerminalManager`：会话级操作与按槽 reconcile

新行为的**全部逻辑**都落在这一步。此步**不动任何 UI**（tree / package.json
留给 Task 3），so 它靠单测与 e2e 的新用例验证。

### 文件
- `src/terminalManager.ts`
- `src/extension.ts`（**只改 `pollActivity` 一处**：它现在把**条目 id** 当键喂给
  `tracker.poll`，而采样层已按**槽 id** 派生会话名。键必须与采样层同源，否则
  同一终端的第 2 个会话**永远不会有运行图标** —— 静默、无测试能抓。其余
  extension.ts 的改动属 Task 3）
- `test/e2e-harness.js`（新增用例，SPEC §12.4 里**不需要 UI 的那几条**）
- `test/activityTracker.test.ts`（键改成槽 id，SPEC §12.2）

> **Task 1 留下的一处临时耦合，本 Task 要收掉**：Task 1 里新建/复制出的槽，
> 其 `id` **借用了条目 id**（当时的理由是 extension.ts 被冻结、仍按条目 id
> 派生会话名，两者必须指同一个会话）。本 Task 让 extension.ts 也走槽 id 之后，
> 这层耦合不再需要 —— **新建与复制出来的槽一律用 `newId()`**（迁移合成的槽
> 仍必须等于原条目 id，那是另一回事，SPEC §11.1，**不要动**）。

### 步骤

1. `reconcileAll` / `reconcileOne` / `liveFor` / `resolveLaunchSpec` 全部按
   SPEC §8.1 改到槽上。要点：
   - 循环是**条目 × 槽**；只处理该**槽**的 tmux 会话存活的那些
   - 整批仍**共用一份** `LivenessSnapshot`（这条约束不许破）
   - `reconcileBinding` 的调用**形状不变**，喂进去的是槽
   - 回写一律 `store.updateSession(entry.id, slot.id, patch)`
   - `titles.prewarm(patch?.conversationId ?? slot.conversationId, this.cwdFor(entry))`
2. `openSession(entry, slot, opts?)`：SPEC §8 第 1、3 点之外的
   **全部既有逻辑与不变量逐字保留**（`decideOpen` / `allowLaunch` 竞态闸门 /
   `reuse-attach` 只在证明空闲时 / 发送前重算 `isShellReady` /
   `warnIfResumeFailed`）。**这些注释一行都不许删** —— 它们是这个文件里最贵的
   知识。只允许把注释里的主语从「条目」改成「会话/槽」，并在改动处补一句为什么。
3. `resolveLaunchSpec(entry, slot, live)`：绑定来源改 `slot.conversationId`；
   兜底 D 的唯一性判据仍按**条目**数（SPEC §11.16，那里解释了为什么不冲突）；
   未绑定分支的 QuickPick 文案要带上**终端名 + 会话**（否则用户分不清在给谁选）。
4. 三个「关闭/删除」（SPEC §7.3 的表，**这是最易写错的一处**）：
   - 抽一个私有 `killSlot(session: string): Promise<void>`，内容是
     `killSession` 现在的三步且**顺序不可换**（detach → kill → dispose + 从
     Map 删），注释照搬
   - `closeSession(entry, slot)` = 模态确认 + `killSlot`，**绝不动槽**
   - `deleteSession(entry, slot)` = 模态确认 + `killSlot` +
     `store.removeSession(entry.id, slot.id)`
   - `deleteEntry(entry)` = 模态确认（文案改成「会杀掉其下 N 个会话」）+
     逐槽 `killSlot` + `store.remove(entry.id)`
   - `killSession(entry)`（保留此名）= 模态确认 + 逐槽 `killSlot`，保留条目
   - **每个模态确认框都要点名作用对象**（终端名 + 任务名/槽）
5. `addSessionInteractive(entry)`：**零弹框**（SPEC §7.4），只
   `store.addSession(entry.id, { id: newId() })`。
6. `addEntryInteractive(defaultCwd?)`：SPEC §7.4，新建条目**带 1 个空槽**
   （槽 id 用 `newId()`；**注意：新建条目的槽 id 不必等于条目 id** ——
   那条规则只属于 v1/v2 迁移。这里用新 id 更干净，两种来源都不会撞）。
7. `duplicateEntry(entry)`：SPEC §7.6，**逐槽**重造 id 与 conversationId、
   剥掉 liveSessionId、保留槽数与槽 order。
8. `setColorInteractive(entry)`（SPEC §6.4）：8 个预设 + 末项「自定义…」→
   `showInputBox` → `normalizeHexColor` 校验（非法值**必须报错重问或放弃，
   绝不写进清单**）→ `store.update(entry.id, { color })`。
9. `restoreAll()`：SPEC §8.3（flatten 到槽、逐槽 `openSession`，仍并行不 await、
   仍 50ms 错开、仍逐条 catch）。
10. `applyModel` / `applyProfile`：**仍作用在条目上**（SPEC §7.5），
    但要把「其下所有**存活**的槽」都重启（切 profile 时每个存活槽都要
    `/exit` + `--resume` 自己的对话）。`restartClaude(entry, slot, launch)` 多一个槽参数。
11. e2e 新增用例：SPEC §12.4 里这几条（**不含**颜色文件、不含 UI 断言）：
    多会话各自独立打开、X 语义、删除会话 vs 删除条目、新建会话零弹框、
    profile/model 属于二级、复制、迁移端到端、二级不再打开。
12. `test/activityTracker.test.ts`：键换成槽 id + 新增「同终端两个槽各自独立采样」。

### Expected
- `npm test` 全绿，用例数 **> Task 1 结束时**的数字。
- `npm run e2e` 全绿，且**新增了 SPEC §12.4 里那 8 条**（贴出这些用例名与结果）。
- `grep -n "store.update(.*conversationId\|store.update(.*liveSessionId" src/` → 无输出
  （绑定回写全部走 `updateSession`）。
- `grep -c "killSlot" src/terminalManager.ts` → 至少 5 处（1 定义 + 4 调用）。
- X 语义的专项证据：e2e 里「关闭后槽仍在、再打开是 `--resume <原 id>`」这条
  必须**通过**，且把该用例名贴进回报。

### 提交

```
feat: 会话级操作与按槽 reconcile

打开/接回、关闭（X）、删除会话、新建会话、颜色，全部落到会话槽上；
reconcile 与「选择要接回的对话」随之下移到槽。profile/模型/颜色/参与恢复
仍只存在二级条目一份，三级上的这些菜单项转发到所属终端。

X 只杀 tmux 进程、槽与对话绑定原样保留 —— 这是「三级是接回会话的」能
成立的前提：再点那一行就是 --resume 回同一条对话。
```

---

## Task 2b — 补两个洞：新槽的 `conversationId`、兜底 D 的占用判据

Task 2 的实施暴露了 SPEC 的两处**自身缺陷**（都是多会话模型新引入的，
不是实现写错）。两条都已在 SPEC 里改定：§7.4 与 §11.16。

### 文件
- `src/terminalManager.ts`（`addSessionInteractive` 一行 + `resolveLaunchSpec` 的 D 分支）
- `test/core/*.test.ts`（若 D 的判据抽成了纯函数则补其单测）
- `test/e2e-harness.js`（D 的两侧用例）

### 步骤

1. **`addSessionInteractive` 必须预分配 `conversationId`**（SPEC §7.4 的新正文）：

   ```ts
   await this.store.addSession(entry.id, {
     id: newId(),
     conversationId: newConversationId(),
   });
   ```
   理由写在 SPEC §7.4：留空会让「+ 然后点开」落进未绑定路径 → 兜底 D
   **静默 `--resume` 该 cwd 下 mtime 最新的对话**，而不是开一条新对话。
   这与 `addEntryInteractive`（已预分配）必须是同一条路径。

2. **兜底 D 增加判据 (b)：候选对话不得被任何槽占用**（SPEC §11.16）。
   用现成的 `ownersOf`（`core/conversation.ts:283`）把所有条目的**所有槽**
   摊平成 `BindingView[]`，取第一个**无主**候选；无主候选一个都没有时
   **不启用 D**，退回弹框。**判据 (a)「该 cwd 下只有这一个条目」保留不动。**

3. 测试：
   - 新槽预分配的专项断言：`addSessionInteractive` 后槽的 `conversationId`
     是**非空字符串**、且 `liveSessionId` 仍是 undefined。
   - D 的**两侧**：① 候选无主 → 自动采用（原行为，不许回归）；
     ② **候选已被同一终端的另一个槽绑着 → 绝不自动采用，必须弹框**
     （这是本 Task 的核心回归，对应 SPEC §11.16 那条可达路径）。
   - e2e 里「老条目 + 无主候选自动接回、不弹框」这条原用例必须仍然绿。

### Expected

- `npm test` 全绿且用例数 **> Task 2 结束时**的数字。
- `npm run e2e` 全绿，断言数 **> 212**（新增 D 的占用用例 + 新槽预分配用例）。
- `grep -n "addSessionInteractive" -A 6 src/terminalManager.ts` 里能看到
  `conversationId: newConversationId()`。
- **变异确认**：把判据 (b) 去掉（只看 (a)）→ 新增的「候选已被兄弟槽占用」
  用例必须变红。贴出变红证据。

### 提交

```
fix: 新会话槽预分配对话 id；兜底 D 不再采用已被占用的对话

两处都是多会话模型自己引入的洞：

1. 「+」新建的槽留空 conversationId，会让「点开」落进未绑定路径，被兜底 D
   静默接上该 cwd 下 mtime 最新的对话 —— 而不是用户期待的新对话。
   与 addEntryInteractive 对齐，一出生就分配一个「还没有 .jsonl」的 id。

2. 兜底 D 原本靠「该 cwd 下只有这一个条目」排除竞争者，而多会话让竞争者
   可以来自同一个条目：老条目的未绑定槽 + 同终端另一个正在写的槽，
   D 会把两者接到同一条 .jsonl 上（两个 claude 同写一份，数据损坏级）。
   补一条判据：候选必须无主（ownersOf），有主则退回弹框。
```

---

## Task 2c — 归属判据的第三处：`pickConversation` 也必须按槽 id 摊平

Task 2b 修好了兜底 D，但它在 `pickConversation` 旁边留下了一句**与事实不符**的
注释：「同一个终端下的多个槽绑的是不同对话，它们之间不存在『争同一条』」。
**这句是错的** —— 没有任何东西阻止两个槽绑同一条对话（用户手动选就能做到）。
按**条目 id** 摊平 + 按条目 id 跳过自己，会让兄弟槽**彼此全被跳过**，于是
「已绑给「X」」标记与二次确认**静默消失**，用户可以把第二个槽绑到兄弟槽正在
写的对话上（两个 claude 同写一条 `.jsonl`，正是 `ownersOf` 那套机制存在的
唯一理由）。见 SPEC §11.17（本条新增的不变量）。

### 文件
- `src/terminalManager.ts`
- `test/e2e-harness.js`

### 步骤

1. **`pickConversation` 摊平改用槽 id、跳过自己也用槽 id**：
   - 视角：`{ id: slot.id, name: entry.name, conversationId: slot.conversationId }`
     （`name` 仍是**终端名** —— 归属标签要显示的是它）
   - `ownersOf(views, slot.id)`
   - 因此 `pickConversation` 需要多一个 `slot` 参数（见下）
2. **`bindConversationInteractive(entry, slot)`** 多一个槽参数并透传给
   `pickConversation`。这次签名改动是 Task 3 的前置（Task 3 要在
   `extension.ts` 里按三级节点传槽）。
3. 顺手对齐一处文案：`killSession` 的模态按钮仍是 `杀掉`，而它的提示语已改成
   「关闭该终端下全部会话」。把按钮与判断串一起改成 `关闭`，并同步更新
   `test/e2e-harness.js` 里驱动它的 `modalAnswer`。**只改这个字符串，
   §13 那节的断言（前缀安全）一条都不许动。**
4. 测试（**核心回归**）：构造「条目 E 的槽 s1 绑着对话 C，用户为同条目的槽 s2
   打开选择框」→ 断言
   ① 候选列表里 **C 被标出「已绑给「E」」**（改前不会出现）；
   ② 选中 C 时**弹出二次确认**，拒绝确认则**绑定未改动、什么都没启动**。

### Expected
- `npm test` 全绿、用例数不减。
- `npm run e2e` 全绿、断言数 **> 221**。
- `grep -n "ownersOf" -A 6 src/terminalManager.ts` 里，**两处**摊平都用
  `s.id`/`slot.id` 作为视角 id（`e.id` 不再出现在摊平的 id 位上）。
- **变异确认**：把 `pickConversation` 的视角 id 换回 `e.id`（条目 id）→
  新增的 ①/② 用例必须变红。贴出证据后回退。

### 提交

```
fix: 选择对话的归属判据按槽 id 摊平（兄弟槽也算法占用者）

pickConversation 沿用「按条目 id 摊平 + 按条目 id 跳过自己」的写法，
其隐含前提「一个条目内部不会自己跟自己抢」在 v2 成立、在 v3 不成立：
同一个终端的两个槽可以争同一条对话。按条目跳过自己会让兄弟槽彼此
全被跳过，于是「已绑给「X」」标记与二次确认静默消失 —— 用户能把第二个
槽绑到兄弟槽正在写的 .jsonl 上，两个 claude 同写一份。

同为「一个条目 = 一个行为主体」这个已被推翻的假设的第三处落点（前两处
是兜底 D 与 addSessionInteractive 的 conversationId）。
```

---

## Task 3 — 主树渲染 + 颜色图标 + 命令/菜单接线

**这一步必须整块落地**：`tree.ts` 的 `contextValue` 与 `package.json` 的
菜单 `when` 被 `test/manifest.test.ts` 双向耦合，分开提交会让其中一个方向变红。

### 文件
- `src/tree.ts`（SPEC §6）
- `src/colorIcons.ts`（新增）
- `resources/colors/bar-light.svg`、`resources/colors/bar-dark.svg`（新增）
- `src/extension.ts`（SPEC §6.5 的接线 + 新命令注册）
- `package.json`（命令 + 菜单 + version 保持 0.1.8，**发布时才升**）
- `test/manifest.test.ts`（SPEC §7.2 注记 + §12.2 的两条新断言）
- `test/core/labels.test.ts` 或 `test/core/sessions.test.ts`（`sessionLabel` 的用例，SPEC §12.3）
- `test/e2e-harness.js`（stub 补 `Uri`，SPEC §12.4 第 2 点）

### 步骤
1. `core/sessions.ts` 加 `sessionLabel(taskName: string): string`
   （非空返回任务名，空返回 `'无会话'`）+ 单测。TDD。
2. `Resources`：两个中性竖线 SVG，**显式 `fill`**（`bar-light.svg` 用 `#6e6e6e`、
   `bar-dark.svg` 用 `#c5c5c5`），`viewBox="0 0 16 16"`，
   **绝不出现 `currentColor`**（manifest 测试里记着实测教训）。
3. `src/colorIcons.ts`：`ColorIconCache`（SPEC §6.4 的接口）。`iconFor` 只拼路径、
   **不同步读盘**；非法/未设 → `neutral()`。
4. `src/tree.ts`（SPEC §6.1 ~ §6.3、§6.5）：
   - 删 `TaskTreeItem` → 新增 `SessionTreeItem`；`EntryTreeItem.id` 改
     `entry:${entry.id}`；`FolderTreeItem` 不变（只加 inline `+` 的 when 落点）
   - 四个 `contextValue`：`folder` / `terminal` / `sessionAlive|sessionDead`
     （三级用三元）/ `empty`
   - 二级：竖线 iconPath（`colorIcons.iconFor(entry.color)`，省略时退化
     `ThemeIcon('circle-outline')`）、`description` = profile codicon、
     tooltip 重写（**写明 profile 的文字含义**、去掉「对话」行）、
     `collapsibleState` 与 `sessions.length > 0` 一致、**去掉 `command`**
   - 三级：label 用 `sessionLabel`、四分支图标（SPEC §6.3 的表）、
     `command` = `open`、`markSeen(slot.id)`
   - **删除 `profileColor()`**
   - `activityFor` / `markSeen` / `peek` 一律传 `slot.id` / 槽的 `conversationId`
   - **拖拽排序的 `handleDrag` / `handleDrop` 逻辑与注释一字不改**（SPEC §11.13）
5. `src/extension.ts`：
   - 建 `ColorIconCache`（storage = `context.globalStorageUri` 下的 `colors/`），
     `activate()` 里 `await ensure(清单里所有 color)` 再渲染（SPEC §6.4）
   - `reg` 新增 5 个命令：`addInFolder` / `addSession` / `closeSession` /
     `deleteSession` / `setColor`
   - `item()` 守卫放宽到收 `SessionTreeItem`；`open` 改调 `openSession`
   - `pollActivity` 的 aliveIds 改成**槽 id**（SPEC §6.5）
6. `package.json`：按 SPEC §7.1 加 5 条命令声明、按 SPEC §7.2 重写
   `view/item/context` 的全部 `when` 与 group。**`version` 仍 0.1.8。**
7. `test/manifest.test.ts`：按 SPEC §7.2 的注记把正则**加强**（同时认三元与
   直接赋值）+ 扫描范围扩到 `tree.ts` + `batchTree.ts`；加 §12.2 那两条新断言。
   **两个方向的原断言一字不动。**
8. `test/e2e-harness.js`：stub 补 `Uri`（`file` / `joinPath` / `parse`），
   `ColorIconCache` 指到临时目录。

### Expected
- `npm test` 全绿（含被加强的 manifest 用例）。
- `npm run e2e` 全绿。
- `grep -n "contextValue" src/tree.ts` → 恰好 4 个值：
  `folder` / `terminal` / `sessionAlive`,`sessionDead`(三元) / `empty`。
- `grep -n "profileColor" src/tree.ts` → 无输出。
- `grep -n "TaskTreeItem" src/` → 无输出（类已删，无残留引用）。
- `grep -rn "currentColor" resources/` → 无输出。
- `node -e` 验证 `colorBarSvg('#ff0000')` 含 `fill="#ff0000"` 且不含 `currentColor`。
- `git show --stat HEAD` 里同时含 `src/tree.ts` 与 `package.json`
  （证明耦合的那两步在同一提交里）。

### 提交

```
feat: 三级树改为「文件夹 → 终端 → 会话」

二级的点点换成显示用户颜色的竖线，profile 改由标题后的 codicon 承载
（tooltip 写明文字含义）；三级恒生成、标题回落「无会话」，承载打开/接回
与关闭（X）；二级与一级末尾各加一个「+」。

颜色用自绘 SVG（ThemeIcon 只能取主题色），显式 fill 而不用 currentColor
—— 后者在 VS Code 的 mask 渲染下会整体透明，本仓库已踩过一次。
```

---

## Task 4 — 批量面板：按文件夹分组 + 一级全选

### 文件
- `src/batchTree.ts`（SPEC §9）
- `src/extension.ts`（`batchToggleFolder` 接线）
- `package.json`（声明 `batchToggleFolder`）
- `test/e2e-harness.js`（批量面板的用例，SPEC §12.4）

### 步骤
1. `BatchTreeProvider` 改成两层：一级 `contextValue='batchFolder'`
   （label = 完整 cwd、`id = folder:<cwd>`、`Expanded`、按三态上图标、
   `command = batchToggleFolder` 且 `arguments` 里带上**该组全部子 id**），
   二级仍是 `BatchTreeItem`（`contextValue='batchItem'`，不显示三级）。
2. `batchToggle(ids: string[])`：用 `toggleFolderSelection`（SPEC §9.2）算出新集合。
   **注意选择集合是 `Set<string>`，返回新集合而不是原地改**（SPEC §11 的纯函数约定）。
3. `prune`（`batchTree.ts:71-81`）保留不变。
4. `panel` 的 `entriesFor` / 三个批量命令签名**不变**（SPEC §9.3）。
5. TDD：`core/selection.ts` 的用例 Task 1 已写；这一步补 e2e 的 UI 断言。
6. e2e 新增：点一级标题 → 该组全选；再点 → 全不选；部分选中时点 → **补齐全选**；
   组外条目的选中态不受影响。

### Expected
- `npm test` 全绿。
- `npm run e2e` 全绿 + 上述 4 条批量用例通过（贴用例名）。
- `grep -n "shortLabels" src/` → **只在 `core/labels.ts` 自身的定义处出现**，
  生产代码不再调用它（SPEC §3.3 第 5 条 / §13 的取舍）。**函数与
  `test/core/labels.test.ts` 都保留**，不许删。
- `grep -n "batchFolder" src/batchTree.ts src/extension.ts package.json` → 三处都有。

### 提交

```
feat: 批量面板按文件夹分组，点一级标题即全选其下条目

扁平列表改成「文件夹 → 终端」两层，一级标题是完整 cwd。三态图标
（全选/部分/未选）与「点一下补齐全选」的通行语义放在 core/selection.ts
里，可脱离编辑器单测。

短路径消歧随扁平列表一起退场（函数与其单测保留，不删）。
```

---

## Task 5 — e2e harness：多会话专项用例收口

Task 2/3/4 已经陆续加了用例。这一步做**剩余与收口**：把 SPEC §12.4 的清单
逐条对照一遍，补掉遗漏的那几条，并跑**变异测试**。

### 文件
- `test/e2e-harness.js`
- （可能）`test/core/*.test.ts` 的少量补强

### 步骤
1. 拿 SPEC §12.4 的清单逐条核对 harness，**缺哪条补哪条**（尤其：
   完整 cwd 的批量文件夹、颜色 SVG 落盘且内容含该 hex、
   二级不再打开终端、`addInFolder` 的 cwd 预填）。
2. **变异测试**（SPEC §12.4 末段四处，逐个做、做完立刻回退）：
   ① 迁移里槽 id 写成 `newId()`；② `closeSession` 顺手清 `conversationId`；
   ③ `deleteEntry` 不杀 tmux；④ `folderSelectionState` 把空数组判成 `'all'`。
   **每处都要贴出「哪条断言变红了」** —— 若某处没让任何断言变红，说明该行为
   **缺测试**，补上再重做该变异。

### Expected
- `npm run e2e` 全绿，且用例名能一一对上 SPEC §12.4 的清单。
- 四处变异的**变红证据**（每条一句话：变异点 → 变红的用例名）。
- `npm test` 全绿。

### 提交

```
test: 多会话专项 e2e 用例收口 + 四处变异确认

补齐批量文件夹全选、颜色 SVG 落盘、二级不再打开、一级 + 的 cwd 预填
这几条；并用四处变异（槽 id、X 清绑定、删除条目不杀 tmux、空组判成全选）
逐条确认对应断言真的会红。
```

---

## Task 6 — 文档

### 文件
- `README.md`、`docs/smoke-test.md`

### 步骤
按 SPEC §12.5 逐条改。要点：`## 三个概念` 增「会话」；
`## 侧边栏的层级：第三级「任务名」` → `## 侧边栏的层级：文件夹 → 终端 → 会话`；
`## 排序与批量操作` 改批量分组 + 一级全选、**删掉「短路径消歧」那一节**；
`## 条目 ↔ 对话绑定` 说明绑定是**会话级**的；`## 安装` 里的 vsix 文件名改 0.2.0。
冒烟清单改掉与新模型冲突的三条，并**新增一条「二级的彩色竖线真的画出来了、
且标题后面显示的是 `直连` / `中转` 这两个词」**（渲染结果只能手动看）。

> **不要**再让文档/冒烟清单去期待 profile 的 codicon 图标：SPEC §6.2 与 §13
> 已查证 `TreeItem.description` 不支持 codicon，本轮按纯文本落地。
> README 里也不要写「按 codicon 显示」这类与实现不符的话。

### Expected
- `grep -n "第三级「任务名」" README.md` → 无输出；新标题在。
- `grep -n "短路径消歧" README.md` → 无输出。
- `grep -n "0.1.8" README.md docs/smoke-test.md` → 无输出。
- 冒烟清单里有「彩色竖线是否画出来」「标题后是否显示 `直连`/`中转` 文字」
  这两条人工确认项。
- `grep -n "codicon" README.md docs/smoke-test.md` → 无输出（profile 已改纯文本，
  文档不得再声称是图标）。
- **文档与代码不一致的检查**：README 里提到的每个命令 ID、每个按钮，
  都要在 `package.json` / `src/` 里找得到（不是让你逐字核对，而是
  把 README 提到的命令名 grep 一遍）。

### 提交

```
docs: README 与冒烟清单跟随多会话模型

层级改为「文件夹 → 终端 → 会话」；绑定改成会话级；批量面板按文件夹分组、
一级全选；短路径消歧随扁平列表退场。冒烟清单补上「颜色竖线」与
「profile codicon 是否真的渲染成图标」两条只能手动确认的项。
```

---

## Task 7 — 独立验证 + 发布 v0.2.0

**这一步由主线自己做，不派 executor。** 先派 verifier 做独立核验，
再走发布流程。

### 步骤
1. **派 verifier 独立核验**（SPEC + 本 plan 全文 + 全部 Global Constraints）：
   它自己重跑 `npm test` / `npm run compile` / `npm run e2e`，不采信 executor
   贴的输出。**它报 failed 就先修再发布。**
2. 主线自己**再跑一遍** `npm test` 与 `npm run e2e`（不采信任何人的转述）。
3. `package.json` version → `0.2.0`；`package-lock.json` 的两处 `version`
   一并订正（SPEC §13 发布杂务）。
4. `npm run package` 产出 `vscode-tmux-terminals-0.2.0.vsix`
   （`.gitignore` 里 `*.vsix` 仍忽略，**不要** `git add` 它）。
5. 提交 `chore: 发布 0.2.0`。
6. 打 tag `v0.2.0`（**只打这一个**，0.1.6/0.1.7/0.1.8 不回头补）。
7. `git push` + `git push origin v0.2.0`。凭据已在 git store 里配好，
   **直接用 `git push`，绝不用内联 credential helper 覆盖它。**
8. 回填 SPEC 的 `## 14. 实施后修订`（记录与设计不符之处），若该节有内容，
   单独提交 `docs: 回填实施偏差记录`。

### Expected
- `npm test` 与 `npm run e2e` 的**主线自己跑**的结果（贴关键行）。
- `git tag -l 'v0.2.0'` 有输出；`git ls-remote --tags origin | grep v0.2.0` 有输出。
- `git log --oneline origin/main -1` == 本地 HEAD。
- vsix 文件确实存在且**不在** `git status` 里。
- verifier 的核验结论（通过的条目数 / 有无 failed）。

### 提交
```
chore: 发布 0.2.0
```

---

## 任务依赖图

```
T1（模型，原子）
 └─ T2（manager 逻辑）
     └─ T3（树 + 颜色 + 命令/菜单接线，与 package.json 同提交）
         └─ T4（批量面板）
             └─ T5（e2e 收口 + 变异）
                 └─ T6（文档）
                     └─ T7（独立验证 + 发布）
```

**没有可并行的 Task**：T1 的类型变更贯穿全仓库，T3 与 `package.json` 被
manifest 测试双向耦合。硬要并行只会得到编译不过的中间态。
