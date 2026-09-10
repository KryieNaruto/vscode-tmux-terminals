import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 清单（package.json）与代码的交叉引用校验。
 *
 * 为什么需要这个文件：VS Code 的接线错误**不会让任何单元测试失败** ——
 * 测试直接 import 源码，不经过 package.json。实测踩到的例子：`main`
 * 字段写成 `./out/extension.js`，而实际产物在 `out/src/extension.js`
 * （tsconfig 的 rootDir 是 "."，输出保留了 src/ 层级）。后果是扩展
 * **根本无法激活**，而 78 个测试全绿。
 *
 * 这里只做静态一致性检查，跑一次不到 10ms，能挡住那一整类问题。
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const contributes = pkg.contributes ?? {};
const EXTENSION_SRC = fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8');

describe('package.json 清单一致性', () => {
  it('main 指向真实存在的编译产物', () => {
    const main = pkg.main;
    assert.strictEqual(typeof main, 'string', 'main 字段缺失');
    const abs = path.join(repoRoot, main.replace(/^\.\//, ''));
    assert.ok(
      fs.existsSync(abs),
      `main 指向 ${main}，但该文件不存在。` +
        `注意 tsconfig 的 rootDir 是 "."，编译产物带 src/ 层级（应为 ./out/src/extension.js）。` +
        `这个错误不会让任何行为测试失败，但扩展无法激活。`,
    );
  });

  it('extensionKind 必须是 workspace（否则调用的是本地 tmux，功能全错）', () => {
    assert.deepStrictEqual(pkg.extensionKind, ['workspace']);
  });

  it('声明了 tmuxTerminals 配置区', () => {
    assert.ok(contributes.configuration?.properties, '缺少 contributes.configuration');
  });

  it('代码读取的配置项都有声明', () => {
    const declared = Object.keys(contributes.configuration.properties);
    // 代码里形如 cfg().get<T>('key', ...)，其中 cfg() 已绑定 'tmuxTerminals' 前缀
    const used = [...EXTENSION_SRC.matchAll(/\.get<[^>]*>\('([^']+)'/g)].map((m) => m[1]);
    assert.ok(used.length > 0, '没在 extension.ts 里找到任何配置读取，正则可能过时了');
    const undeclared = used.filter((u) => !declared.includes(`tmuxTerminals.${u}`));
    assert.deepStrictEqual(undeclared, [], `这些配置项被读取但未在 package.json 声明: ${undeclared}`);
  });

  it('声明的配置项都被代码使用（避免死配置）', () => {
    const declared = Object.keys(contributes.configuration.properties).map((k) =>
      k.replace(/^tmuxTerminals\./, ''),
    );
    const used = new Set([...EXTENSION_SRC.matchAll(/\.get<[^>]*>\('([^']+)'/g)].map((m) => m[1]));
    const unused = declared.filter((d) => !used.has(d));
    assert.deepStrictEqual(unused, [], `这些配置项已声明但从未被读取: ${unused}`);
  });

  it('声明的命令都在 extension.ts 里注册了', () => {
    const declared = (contributes.commands ?? []).map((c: { command: string }) => c.command);
    const registered = new Set([...EXTENSION_SRC.matchAll(/reg\('([^']+)'/g)].map((m) => m[1]));
    const missing = declared.filter((c: string) => !registered.has(c));
    assert.deepStrictEqual(missing, [], `声明了但未注册的命令（点了没反应）: ${missing}`);
  });

  it('注册的命令都在 package.json 里声明了', () => {
    const declared = new Set((contributes.commands ?? []).map((c: { command: string }) => c.command));
    const registered = [...EXTENSION_SRC.matchAll(/reg\('([^']+)'/g)].map((m) => m[1]);
    const extra = registered.filter((c) => !declared.has(c));
    assert.deepStrictEqual(extra, [], `注册了但未声明的命令（命令面板里看不到）: ${extra}`);
  });

  it('菜单引用的命令都已声明', () => {
    const declared = new Set((contributes.commands ?? []).map((c: { command: string }) => c.command));
    const inMenus = Object.values(contributes.menus ?? {})
      .flat()
      .map((m: any) => m.command);
    const missing = inMenus.filter((c: string) => !declared.has(c));
    assert.deepStrictEqual(missing, [], `菜单引用了未声明的命令: ${missing}`);
  });

  it('菜单 when 条件里的视图 ID 与声明的视图一致', () => {
    const viewIds = Object.values(contributes.views ?? {})
      .flat()
      .map((v: any) => v.id);
    assert.ok(viewIds.length > 0, '没有声明任何视图');
    const referenced = [...JSON.stringify(contributes.menus ?? {}).matchAll(/view == ([\w.]+)/g)].map(
      (m) => m[1],
    );
    const bad = referenced.filter((v) => !viewIds.includes(v));
    assert.deepStrictEqual(bad, [], `菜单 when 引用了不存在的视图 ID: ${bad}`);
  });

  it('views 的 key 与 viewsContainers 的 id 一致', () => {
    const containerIds = (contributes.viewsContainers?.activitybar ?? []).map((c: any) => c.id);
    const viewKeys = Object.keys(contributes.views ?? {});
    const bad = viewKeys.filter((k) => !containerIds.includes(k));
    assert.deepStrictEqual(bad, [], `views 的 key 没有对应的容器: ${bad}`);
  });

  it('activationEvents 指向真实存在的视图', () => {
    const viewIds = Object.values(contributes.views ?? {})
      .flat()
      .map((v: any) => v.id);
    const viewEvents = (pkg.activationEvents ?? [])
      .filter((e: string) => e.startsWith('onView:'))
      .map((e: string) => e.slice('onView:'.length));
    const bad = viewEvents.filter((v: string) => !viewIds.includes(v));
    assert.deepStrictEqual(bad, [], `activationEvents 引用了不存在的视图: ${bad}`);
  });

  it('视图容器的图标文件真实存在', () => {
    const containers = contributes.viewsContainers?.activitybar ?? [];
    for (const c of containers) {
      const abs = path.join(repoRoot, c.icon);
      assert.ok(fs.existsSync(abs), `视图容器 ${c.id} 的图标不存在: ${c.icon}`);
    }
  });

  it('代码里设置的 viewItem 值都在菜单 when 中使用（避免写了永不生效的 contextValue）', () => {
    const treeSrc = fs.readFileSync(path.join(repoRoot, 'src', 'tree.ts'), 'utf8');
    const setValues = [...treeSrc.matchAll(/contextValue\s*=\s*[^;]*?'(\w+)'\s*:\s*'(\w+)'/g)].flatMap(
      (m) => [m[1], m[2]],
    );
    assert.ok(setValues.length > 0, '没解析出 contextValue，正则可能过时了');
    const usedInMenus = [...JSON.stringify(contributes.menus ?? {}).matchAll(/viewItem == (\w+)/g)].map(
      (m) => m[1],
    );
    // 每个被菜单引用的 viewItem 值都必须由代码设置，否则菜单项永不出现
    const neverSet = usedInMenus.filter((v) => !setValues.includes(v));
    assert.deepStrictEqual(neverSet, [], `菜单引用了代码从不设置的 contextValue（该项永不出现）: ${neverSet}`);
  });
});
