/**
 * mocha `--require` 钩子（见根目录 .mocharc.json）。
 *
 * 在任何测试文件被加载之前，把 `require('vscode')` 接到 vscodeMock.js 上，
 * 这样 `src/terminalManager.ts`（唯一在被测路径上 import 'vscode' 的源文件）
 * 才能在纯 node/mocha 进程里被 require 到，不需要真正的 VS Code extension host。
 */
import * as path from 'path';
import Module = require('module');

type ResolveFilename = (
  request: string,
  parent: unknown,
  isMain: boolean,
  options?: unknown,
) => string;

const vscodeMockPath = path.join(__dirname, 'vscodeMock.js');

// `_resolveFilename` 是 Node 内部 API，不在 @types/node 的公开类型里，
// 全程走 unknown/自定义类型，不依赖官方声明。
const ModuleWithResolver = Module as unknown as { _resolveFilename: ResolveFilename };
const originalResolveFilename: ResolveFilename = ModuleWithResolver._resolveFilename.bind(Module);

ModuleWithResolver._resolveFilename = (
  request: string,
  parent: unknown,
  isMain: boolean,
  options?: unknown,
): string => {
  if (request === 'vscode') return vscodeMockPath;
  return originalResolveFilename(request, parent, isMain, options);
};
