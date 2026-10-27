/**
 * 把 KaTeX 的样式与字体从 node_modules 拷进 resources/。
 *
 * 为什么要拷而不是直接引用 node_modules：`node_modules` 不进 vsix
 * （`.vscodeignore` 排除它），而 webview 的 localResourceRoots 只放开
 * `resources/`。打包前由 `vscode:prepublish` 钩子自动跑一次。
 *
 * 只拷 `.woff2`：KaTeX 的 dist/fonts 里同时有 woff2 / woff / ttf，三者
 * 内容等价，全拷会让 vsix 多出十几 MB。现代 VS Code 的 Electron 只吃 woff2。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'katex', 'dist');
const dst = path.join(__dirname, '..', 'resources', 'katex');

if (!fs.existsSync(src)) {
  // 没装依赖就跑打包是用户的操作顺序问题，不该让构建失败 —— 面板会退化成
  // 没有公式样式（公式仍是 HTML，只是不是 KaTeX 排版）。
  console.warn('[copy-katex] 未找到 node_modules/katex，跳过');
  process.exit(0);
}

fs.mkdirSync(path.join(dst, 'fonts'), { recursive: true });

fs.copyFileSync(path.join(src, 'katex.min.css'), path.join(dst, 'katex.min.css'));
const license = path.join(src, 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(dst, 'LICENSE'));

let copied = 0;
for (const name of fs.readdirSync(path.join(src, 'fonts'))) {
  if (!name.endsWith('.woff2')) continue;
  fs.copyFileSync(path.join(src, 'fonts', name), path.join(dst, 'fonts', name));
  copied += 1;
}

console.log('[copy-katex] 已复制 ' + copied + ' 个 woff2');
