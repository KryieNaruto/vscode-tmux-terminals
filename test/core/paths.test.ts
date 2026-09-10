import * as assert from 'assert';
import {
  discoverCandidates,
  displayPath,
  expandHome,
  parentOf,
  rankCandidates,
  scanRoots,
  validateName,
} from '../../src/core/paths';

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
  it('与已有条目重名报错', () => {
    assert.notStrictEqual(validateName('paint-pc', existing), null);
  });
  it('重名判断区分大小写', () => {
    assert.strictEqual(validateName('PAINT-PC', existing), null);
  });
  it('名字两侧空白被忽略后再判重', () => {
    assert.notStrictEqual(validateName('  paint-pc  ', existing), null);
  });

  // 以下三条是「会话名改由 id 派生」后的解禁项。
  // 显示名不再进入 tmux 目标语法，故这些字符不再有技术风险。
  it('含冒号放行（显示名不再用作 tmux 目标）', () => {
    assert.strictEqual(validateName('a:b', existing), null);
  });
  it('含点号放行', () => {
    assert.strictEqual(validateName('build.android', existing), null);
  });
  it('纯数字放行（不再与 tmux 会话索引冲突）', () => {
    assert.strictEqual(validateName('123', existing), null);
  });

  // 换行仍须拒绝：会破坏 TreeView 的单行展示
  it('含换行报错', () => {
    assert.notStrictEqual(validateName('a\nb', existing), null);
  });
  it('含回车报错', () => {
    assert.notStrictEqual(validateName('a\rb', existing), null);
  });
});

describe('rankCandidates', () => {
  it('已用过的排在最前，且去重', () => {
    const r = rankCandidates(['/used'], ['/new', '/used']);
    assert.deepStrictEqual(r.items, ['/used', '/new']);
  });

  it('截断时报告数量（不能静默丢弃）', () => {
    const r = rankCandidates([], ['/a', '/b', '/c'], 2);
    assert.deepStrictEqual(r.items, ['/a', '/b']);
    assert.strictEqual(r.truncated, 1);
  });

  it('空串与纯空白被剔除', () => {
    assert.deepStrictEqual(rankCandidates(['', '  '], []).items, []);
  });
});

describe('displayPath', () => {
  const home = '/home/u';
  it('家目录本身显示为 ~', () => {
    assert.strictEqual(displayPath('/home/u', home), '~');
  });
  it('家目录下的路径显示为 ~/…', () => {
    assert.strictEqual(displayPath('/home/u/workspace/Mine', home), '~/workspace/Mine');
  });
  it('家目录之外的绝对路径原样', () => {
    assert.strictEqual(displayPath('/ssd/u/workspace', home), '/ssd/u/workspace');
  });
  it('不误伤前缀相同的兄弟目录（/home/user vs /home/u）', () => {
    assert.strictEqual(displayPath('/home/user/x', home), '/home/user/x');
  });
});

describe('parentOf', () => {
  it('取父目录', () => {
    assert.strictEqual(parentOf('/ssd/u/workspace'), '/ssd/u');
  });
  it('根目录返回自身（不会无限上溯）', () => {
    assert.strictEqual(parentOf('/'), '/');
  });
  it('单层目录返回根', () => {
    assert.strictEqual(parentOf('/ssd'), '/');
  });
});

describe('scanRoots', () => {
  const home = '/home/u';

  it('★ 已用目录被当作扫描根（否则它的子目录永远列不出来）', () => {
    const r = scanRoots(['/ssd/u/workspace'], home);
    assert.ok(r.includes('/ssd/u/workspace'), `实际：${r.join(', ')}`);
  });

  it('★ 已用目录的父目录也被扫描（这样能列出同级目录）', () => {
    const r = scanRoots(['/ssd/u/workspace'], home);
    assert.ok(r.includes('/ssd/u'), `实际：${r.join(', ')}`);
  });

  it('不含硬编码的 ~/workspace（工作树未必在家目录下）', () => {
    const r = scanRoots(['/ssd/u/workspace'], home);
    assert.ok(!r.includes('/home/u/workspace'), `实际：${r.join(', ')}`);
  });

  it('家目录仍被扫描（作为兜底）', () => {
    assert.ok(scanRoots([], home).includes(home));
  });

  it('去重', () => {
    const r = scanRoots(['/ssd/u/workspace', '/ssd/u/workspace'], home);
    assert.strictEqual(r.filter((x) => x === '/ssd/u/workspace').length, 1);
  });

  it('条目里的 ~ 会先展开', () => {
    const r = scanRoots(['~/mine/paint'], home);
    assert.ok(r.includes('/home/u/mine/paint'), `实际：${r.join(', ')}`);
  });
});

describe('discoverCandidates', () => {
  const home = '/home/u';

  // 真实复现：home 在 /home/u，而工作树在 /ssd/u/workspace，两者毫无关系。
  const tree: Record<string, string[]> = {
    '/home/u': ['Android', '.cache', 'workspace'],
    '/ssd/u': ['workspace'],
    '/ssd/u/workspace': ['mine', 'work', 'windows', 'test'],
    '/ssd/u/workspace/mine': ['paint-pc'],
  };
  const readSubdirs = async (d: string) => tree[d] ?? [];

  it('★ 回归：工作树不在 home 下时，其子目录仍须出现', async () => {
    const roots = scanRoots(['/ssd/u/workspace'], home);
    const out = await discoverCandidates(roots, home, readSubdirs);
    assert.ok(
      out.includes('/ssd/u/workspace/mine'),
      `未列出 mine。实际：${out.join(', ')}`,
    );
  });

  it('★ 回归：列出的是工作树下的目录，而不只是 home 那一堆', async () => {
    const roots = scanRoots(['/ssd/u/workspace'], home);
    const out = await discoverCandidates(roots, home, readSubdirs);
    for (const want of ['mine', 'work', 'windows', 'test']) {
      assert.ok(out.includes(`/ssd/u/workspace/${want}`), `缺 ${want}：${out.join(', ')}`);
    }
  });

  it('家目录下的路径显示成 ~/…', async () => {
    const out = await discoverCandidates([home], home, readSubdirs);
    assert.deepStrictEqual(out.sort(), ['~/Android', '~/workspace']);
  });

  it('隐藏目录被跳过', async () => {
    const out = await discoverCandidates([home], home, readSubdirs);
    assert.ok(!out.some((p) => p.includes('.cache')), out.join(', '));
  });

  it('某个根不存在/不可读时静默跳过，不影响其他根', async () => {
    const out = await discoverCandidates(['/nope', '/ssd/u/workspace'], home, readSubdirs);
    assert.ok(out.includes('/ssd/u/workspace/mine'), out.join(', '));
  });
});
