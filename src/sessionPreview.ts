import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { PreviewMessage, TranscriptReader } from './core/transcript';

/**
 * 首载最多渲染多少条。
 *
 * 一条会话的文件可以大到 7.8 MB（实测），逐条走 `markdown.api.render` 是
 * 一次 IPC + 一次 KaTeX 排版。面板要的是「现在在聊什么」，不是全部历史 ——
 * 取尾部既最快，也正好是用户关心的那一段。超出的部分用一行提示说出来，
 * **不静默丢**。
 */
const MAX_MESSAGES = 200;

/** 面板 id。`createWebviewPanel` 的 key，改动它等于换一个面板。 */
const VIEW_TYPE = 'tmuxTerminals.sessionPreview';

/** HTML 转义。降级路径必须用它，否则原始 markdown 里的 `<` 会被当标签吃掉。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 用 VS Code 内置的 markdown 引擎渲染正文。
 *
 * 为什么借它而不是自己引 markdown-it：内置 `markdown-language-features` 注册了
 * `markdown.api.render`，而且引擎会应用所有 `contributes["markdown.markdownItPlugins"]`
 * 的扩展 —— 内置 `markdown-math` 就是其中一个，于是 `$…$` / `$$…$$` / ```math``` 围栏
 * 会被转成 KaTeX 的 HTML。自引一套只会多一条语法路径。
 *
 * 它是内部命令（不在 vscode.d.ts 里），必须兜底：禁用 markdown 扩展 / 关掉
 * `markdown.math.enabled` 时可能抛错或返回非字符串 —— 降级成转义后的 <pre>，
 * 面板宁可显示原始文本，不能空白。
 *
 * `execute` 可注入，便于单测不依赖扩展宿主。
 */
export async function renderMarkdown(
  markdown: string,
  execute: (command: string, arg?: unknown) => Thenable<unknown> = (c, a) =>
    vscode.commands.executeCommand(c, a),
): Promise<string> {
  try {
    const out = await execute('markdown.api.render', markdown);
    if (typeof out === 'string' && out.length > 0) return out;
  } catch {
    // 走下面的降级
  }
  return `<pre class="fallback">${escapeHtml(markdown)}</pre>`;
}

/**
 * 「某个 claude 会话的正文」预览面板。
 *
 * 生命期与扩展一致（进 `context.subscriptions`），但**面板本身**可以随时被
 * 用户关掉：关掉只清面板，控制器留着，下次 show 再建一个。两者分开是因为
 * 「扩展活着」与「面板开着」是两个独立事实，混成一个字段就会在用户关面板后
 * 把控制器一起判死。
 *
 * 换目标会话时所有异步回调都要能识别「自己属于上一代」：`generation` 每 show
 * 一次自增，回调先比对再落地 —— 否则旧文件读回来的消息会追加到新会话的
 * 面板里，且看不出任何异常。
 */
export class SessionPreviewController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  /** 当前预览的文件（绝对路径）。watchFile 与 reader 都以它为准。 */
  private file = '';
  /** 已读到但还没渲染 / 还没发出去的消息。 */
  private pending: PreviewMessage[] = [];
  /** webview 是否已经发来 `ready`。没 ready 时发消息是白发（页面还没脚本）。 */
  private ready = false;
  /** 重入闸门：watchFile 的 tick 不排队，正在跑就跳过，下一拍自然会来。 */
  private syncing = false;
  /**
   * 「ready 来了，但恰好有一次旧文件的 sync 还在跑」。
   *
   * 这种情况下**不能**像 watchFile 那样直接丢弃：那个旧 sync 结束时会因
   * generation 不符而丢弃结果，如果首载也跟着丢了，面板会一直空白，直到文件
   * 下一次发生变化为止（可能好几分钟）。记一个标志，等它结束再补跑一次。
   */
  private initialQueued = false;
  /** 下一轮 flush 要不要先让面板清空（读到了 reset 标志）。 */
  private resetPending = false;
  /** 换目标的代数，见类注释。 */
  private generation = 0;
  /** 是否已经吃过 watchFile 的第一次回调（那次 prev 全是 0，是噪声）。 */
  private started = false;
  /** 渲染必须串行：多个 `markdown.api.render` 并发会乱序。 */
  private chain: Promise<void> = Promise.resolve();
  private readonly reader = new TranscriptReader();

  /**
   * watchFile 的回调。
   *
   * 第一次回调的 prev 是「全 0 的假快照」，mtime/size 必然与 curr 不同 ——
   * 不跳过的话每次 start 都会先白读一遍文件。跳过它，真实变化一次都不会漏：
   * 文件在这之后只要动过，下一次 tick 就会给出非零的 prev。
   */
  private readonly watchListener = (curr: fs.Stats, prev: fs.Stats): void => {
    if (!this.started) {
      this.started = true;
      return;
    }
    if (curr.mtimeMs !== prev.mtimeMs || curr.size !== prev.size) void this.sync({});
  };

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * 显示（或切换）预览目标。
   *
   * 面板已存在时**不复用旧页面**：直接重设 html 等于刷新，这样 webview 侧
   * 的旧消息队列、旧滚动位置一并清掉，不会把上一个会话的内容混进来。
   * 代价是要重新等一次 `ready` —— 这正是下面为什么每条路径都从 ready 起步。
   */
  async show(opts: { file: string; title: string }): Promise<void> {
    this.generation += 1;
    this.stopWatching();
    this.reader.reset();
    this.file = opts.file;
    this.pending = [];
    this.resetPending = false;
    this.initialQueued = false;
    this.ready = false;

    let panel = this.panel;
    if (panel === undefined) {
      panel = this.createPanel(opts.title);
    } else {
      panel.title = opts.title;
      panel.reveal(vscode.ViewColumn.Beside);
    }
    this.panel = panel;

    // 新建与复用两条路径都要重新给 html：新建时没有它 webview 是空白，
    // 复用时要靠它把旧页面刷掉。
    panel.webview.html = this.html(panel.webview);

    this.startWatching();
  }

  private createPanel(title: string): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // 用户切去终端再切回来时不能重载：重载会丢滚动位置并重新走一遍首载。
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources')],
      },
    );
    panel.onDidDispose(() => {
      // 只在「当前面板就是它」时清理：dispose() 会先清 this.panel 再调
      // panel.dispose()，晚到的回调不该把刚重建的新面板的 watcher 也停掉。
      if (this.panel !== panel) return;
      // 面板没了就不再需要 watch —— 白 poll 一个可能很大的文件没有意义。
      this.stopWatching();
      this.panel = undefined;
      this.ready = false;
      this.pending = [];
    });
    panel.webview.onDidReceiveMessage((msg: unknown) => {
      void this.onMessage(msg);
    });
    return panel;
  }

  dispose(): void {
    this.stopWatching();
    const panel = this.panel;
    this.panel = undefined;
    this.ready = false;
    this.pending = [];
    panel?.dispose();
  }

  /** webview → 扩展。**只认两种消息**，其余一律忽略。 */
  private async onMessage(msg: unknown): Promise<void> {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: unknown; href?: unknown };
    if (m.type === 'ready') {
      this.ready = true;
      if (this.syncing) {
        this.initialQueued = true; // 见字段注释：不能在这里丢
        return;
      }
      await this.sync({ initial: true });
      return;
    }
    if (m.type === 'open' && typeof m.href === 'string') {
      const u = m.href;
      // **只放行 http/https**：`command:` 能借用户一次点击执行任意命令，
      // `file:` 能把本地文件路径递给外部程序。这两个入口都没有存在的必要。
      if (u.startsWith('http://') || u.startsWith('https://')) {
        await vscode.env.openExternal(vscode.Uri.parse(u));
      }
    }
  }

  /**
   * 读一次增量并交给 flush。重入时直接返回：watchFile 每秒都会再来，
   * 排队只会积压一串「读了但内容早已被下一拍覆盖」的无效工作。
   */
  private async sync(opts: { initial?: boolean }): Promise<void> {
    if (this.syncing) return;
    if (this.panel === undefined || !this.ready) return;

    const gen = this.generation;
    this.syncing = true;
    try {
      const { messages, reset } = await this.reader.readNew(this.file);
      if (gen !== this.generation) {
        // 期间换了目标，这一批属于上一代。**必须 reset reader**：show() 里的
        // reset 发生在这次读盘途中，旧的 readNew 收尾时又把 offset/ino 写了
        // 回去，不清掉的话下一次会从新文件的错误偏移处开始解析。
        this.reader.reset();
        return;
      }

      if (reset && opts.initial !== true) {
        // 文件被截断或换成了另一个 inode：之前发出去的内容已经不作数，
        // 面板必须清空后重建（这正是 reset 消息的用途）。
        this.pending = messages;
        this.resetPending = true;
      } else {
        this.pending.push(...messages);
      }
      await this.flush(gen, opts.initial === true);
    } catch {
      // 文件暂时不在（被清理 / 正在轮转）：watchFile 会继续盯着，
      // 它再出现时 mtime 变化自然会触发下一拍。这里不能抛，否则会打断链。
    } finally {
      this.syncing = false;
      if (this.initialQueued) {
        this.initialQueued = false;
        void this.sync({ initial: true });
      }
    }
  }

  /**
   * 把 pending 渲染并推给面板。
   *
   * 渲染挂在同一条 `chain` 上串行执行 —— 并发调用 `markdown.api.render` 时
   * 返回顺序没有保证，乱序追加会让对话看起来「跳来跳去」。
   */
  private async flush(gen: number, initial: boolean): Promise<void> {
    if (this.panel === undefined || !this.ready) return; // 面板不可见 / 未就绪 → 留着
    if (this.pending.length === 0 && !this.resetPending) return;

    let messages = this.pending;
    this.pending = [];
    const redo = this.resetPending;
    this.resetPending = false;

    if (initial && messages.length > MAX_MESSAGES) {
      const hidden = messages.length - MAX_MESSAGES;
      // 复用成一条普通 assistant 消息而不是新协议字段：webview 只需要认
      // role/text，面板侧不会因为多一种 message 类型而各个分支都要改。
      messages = [
        { role: 'assistant', text: `> 更早的 ${hidden} 条未显示。` },
        ...messages.slice(-MAX_MESSAGES),
      ];
    }

    const work = async (): Promise<void> => {
      const items: { role: PreviewMessage['role']; html: string }[] = [];
      for (const m of messages) {
        const html = await renderMarkdown(m.text);
        if (gen !== this.generation) return; // 渲染期间换了目标
        items.push({ role: m.role, html });
      }
      const panel = this.panel;
      if (panel === undefined || gen !== this.generation) return;
      if (redo) await panel.webview.postMessage({ type: 'reset' });
      await panel.webview.postMessage({ type: 'append', items });
    };

    // catch 必须留在链上：一次失败若让 chain 变成 rejected，之后所有
    // `.then` 都会被跳过 —— 面板会永久停止更新，且一声不吭。
    this.chain = this.chain.then(work).catch(() => {});
    await this.chain;
  }

  private startWatching(): void {
    this.started = false;
    // persistent: false —— 一个预览面板不该把扩展宿主钉在事件循环里。
    fs.watchFile(this.file, { interval: 1000, persistent: false }, this.watchListener);
  }

  private stopWatching(): void {
    fs.unwatchFile(this.file, this.watchListener);
  }

  /**
   * 面板 HTML。
   *
   * 每次调用都新建 nonce：CSP 的 `script-src` 只放行这一个 nonce，页面上
   * 唯一的脚本就是下面那段。`'unsafe-inline'` **只**给 style —— KaTeX 的
   * 输出带行内 style，去掉它公式就会错位；而 style 注入拿不到执行权。
   */
  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const katex = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'katex', 'katex.min.css'),
    );

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  img-src ${webview.cspSource} data:;
  font-src ${webview.cspSource};
  style-src ${webview.cspSource} 'unsafe-inline';
  script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${katex}">
<style>
  body {
    padding: 12px 16px;
    line-height: 1.6;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
  }
  .msg {
    padding: 10px 12px;
    border-radius: 4px;
  }
  .msg + .msg {
    border-top: 1px solid var(--vscode-panel-border);
    border-radius: 0;
  }
  .role {
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 4px;
  }
  .body { overflow-wrap: anywhere; }
  .body p { margin: 0.4em 0; }
  code, pre {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.15));
  }
  code { padding: 0 3px; border-radius: 3px; }
  pre {
    overflow: auto;
    padding: 8px;
    border-radius: 4px;
  }
  pre code { padding: 0; background: none; }
  img { max-width: 100%; }
  a { color: var(--vscode-textLink-foreground); }
  .fallback { white-space: pre-wrap; }
  /* 块级公式比面板宽时横向滚动，不要撑破整个页面。 */
  .katex-display { overflow-x: auto; overflow-y: hidden; }
</style>
</head>
<body>
<main id="log"></main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const NEAR_BOTTOM = 60;
  function atBottom() {
    return window.innerHeight + window.scrollY >= document.body.scrollHeight - NEAR_BOTTOM;
  }
  function add(items) {
    // 追加前先记住「用户是不是贴着底部」：是就跟着滚，不是就别抢他的滚动位置。
    const stick = atBottom();
    for (const it of items) {
      const el = document.createElement('article');
      el.className = 'msg ' + it.role;
      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = it.role === 'user' ? '你' : 'Claude';
      const body = document.createElement('div');
      body.className = 'body';
      body.innerHTML = it.html;          // 内容是扩展侧渲染的 markdown HTML
      el.appendChild(role);
      el.appendChild(body);
      log.appendChild(el);
    }
    if (stick) window.scrollTo(0, document.body.scrollHeight);
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'reset') { log.innerHTML = ''; return; }
    if (m.type === 'append') add(m.items || []);
  });
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && a.href) { e.preventDefault(); vscode.postMessage({ type: 'open', href: a.href }); }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
