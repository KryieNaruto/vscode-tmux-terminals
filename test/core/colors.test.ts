import * as assert from 'assert';
import { PRESET_COLORS, colorBarSvg, colorChoices, colorSwatchSvg, normalizeHexColor } from '../../src/core/colors';

describe('normalizeHexColor', () => {
  it('三位简写逐位展开：#abc → #aabbcc', () => {
    assert.strictEqual(normalizeHexColor('#abc'), '#aabbcc');
  });

  it('大小写混写一律落成小写', () => {
    assert.strictEqual(normalizeHexColor('#AABBCC'), '#aabbcc');
    assert.strictEqual(normalizeHexColor('#AbC'), '#aabbcc');
  });

  it('不带 # 的六位也接受', () => {
    assert.strictEqual(normalizeHexColor('aabbcc'), '#aabbcc');
  });

  it('不带 # 的三位也接受', () => {
    assert.strictEqual(normalizeHexColor('abc'), '#aabbcc');
  });

  it('首尾空白被忽略（用户从别处粘贴常带空格）', () => {
    assert.strictEqual(normalizeHexColor('  #AABBCC  '), '#aabbcc');
    assert.strictEqual(normalizeHexColor('\tabc\n'), '#aabbcc');
  });

  it('★ 空串 → undefined（绝不猜一个近似色）', () => {
    assert.strictEqual(normalizeHexColor(''), undefined);
    assert.strictEqual(normalizeHexColor('   '), undefined);
    assert.strictEqual(normalizeHexColor('#'), undefined);
  });

  it('★ 位数不对 → undefined（#abcd / #12345 / 七位）', () => {
    assert.strictEqual(normalizeHexColor('#abcd'), undefined);
    assert.strictEqual(normalizeHexColor('#12345'), undefined);
    assert.strictEqual(normalizeHexColor('#1234567'), undefined);
  });

  it('★ 非十六进制字符 → undefined（#gggggg）', () => {
    assert.strictEqual(normalizeHexColor('#gggggg'), undefined);
    assert.strictEqual(normalizeHexColor('#12g45f'), undefined);
  });

  it('★ 颜色名 → undefined（本模块只认 hex，不查 CSS 颜色表）', () => {
    assert.strictEqual(normalizeHexColor('red'), undefined);
    assert.strictEqual(normalizeHexColor('transparent'), undefined);
  });

  it('★ 归一化是幂等的：产物再归一化还是它自己', () => {
    assert.strictEqual(normalizeHexColor(normalizeHexColor('#ABC')!), '#aabbcc');
  });
});

describe('colorBarSvg', () => {
  const RED = '#ff0000';

  it('★ 显式写死 fill，不作任何间接引用', () => {
    assert.ok(colorBarSvg(RED).includes(`fill="${RED}"`), colorBarSvg(RED));
  });

  it('★ 绝不出现 currentColor —— 它会让整个图标透明', () => {
    // 实测教训：VS Code 把图标当 CSS mask 渲染，currentColor 在那里解析不出
    // 颜色，结果是「图标占了位置但什么都看不见」，且不报任何错。
    assert.ok(!colorBarSvg(RED).includes('currentColor'), colorBarSvg(RED));
  });

  it('含 viewBox（16×16 的坐标空间）', () => {
    assert.ok(colorBarSvg(RED).includes('viewBox="0 0 16 16"'), colorBarSvg(RED));
  });

  it('★ 对同一颜色确定：两次调用逐字节相同', () => {
    // 不确定的 SVG 会让 VS Code 每渲染一次就重新读盘一次（路径没变、内容变了）。
    assert.strictEqual(colorBarSvg(RED), colorBarSvg(RED));
  });

  it('颜色不同则产物不同（不是所有颜色都退化成同一张图）', () => {
    assert.notStrictEqual(colorBarSvg('#ff0000'), colorBarSvg('#00ff00'));
  });

  it('竖线几何：细、居中、上下留白', () => {
    const svg = colorBarSvg(RED);
    assert.ok(svg.includes('x="7"') && svg.includes('width="2"') && svg.includes('height="12"'), svg);
  });
});

describe('PRESET_COLORS', () => {
  it('恰好 8 个', () => {
    assert.strictEqual(PRESET_COLORS.length, 8);
  });

  it('★ 每个都是已归一化的小写 #rrggbb（否则调色板自己就带脏数据）', () => {
    for (const c of PRESET_COLORS) {
      assert.strictEqual(normalizeHexColor(c), c, `${c} 不是归一化形态`);
    }
  });

  it('互不重复', () => {
    assert.strictEqual(new Set(PRESET_COLORS).size, PRESET_COLORS.length);
  });
});

describe('colorSwatchSvg', () => {
  const GREEN = '#46a758';

  it('★ 显式写死 fill，不作任何间接引用', () => {
    assert.ok(colorSwatchSvg(GREEN).includes(`fill="${GREEN}"`), colorSwatchSvg(GREEN));
  });

  it('★ 绝不出现 currentColor —— 它会让整个图标透明', () => {
    // 与 colorBarSvg 同一条实测教训：VS Code 把图标当 CSS mask 渲染，
    // currentColor 在那里解析不出颜色，结果是「图标占了位置但什么都看不见」，
    // 且不报任何错。
    assert.ok(!colorSwatchSvg(GREEN).includes('currentColor'), colorSwatchSvg(GREEN));
  });

  it('★ 带不透明描边（故意的，不是花边）', () => {
    // 纯色块没有边界，浅色/深色主题下都可能与背景糊在一起 —— 用户自定义一个
    // 接近白色或接近黑色的 hex 时尤其明显。描边保证「这一项有颜色」在任何主题下
    // 都看得见；用不透明灰是因为 8 位带 alpha 的写法在图标里不保证被支持。
    const svg = colorSwatchSvg(GREEN);
    assert.ok(svg.includes('stroke="#808080"'), svg);
    assert.ok(svg.includes('stroke-width="1"'), svg);
  });

  it('含 viewBox（16×16 的坐标空间，图标按 16px 网格渲染）', () => {
    assert.ok(colorSwatchSvg(GREEN).includes('viewBox="0 0 16 16"'), colorSwatchSvg(GREEN));
  });

  it('★ 与 colorBarSvg 不是同一个图形 —— 谁也没被误改成另一个', () => {
    // 色块是 12×12 的填充方块，竖线是 2×12 的窄条。两个几何都断言，
    // 防的是一侧被复制粘贴成另一侧（那样两边就都「能渲染」但不表达原意）。
    const swatch = colorSwatchSvg(GREEN);
    const bar = colorBarSvg(GREEN);
    assert.notStrictEqual(swatch, bar);
    assert.ok(swatch.includes('width="12"') && swatch.includes('height="12"'), swatch);
    assert.ok(bar.includes('width="2"') && bar.includes('height="12"'), bar);
  });
});

describe('colorChoices', () => {
  const GREEN = '#46a758';

  it('没有当前色：8 个预设、原序、全部 current=false', () => {
    const choices = colorChoices(undefined);
    assert.strictEqual(choices.length, PRESET_COLORS.length);
    assert.deepStrictEqual(choices.map((c) => c.hex), PRESET_COLORS);
    assert.ok(choices.every((c) => c.current === false));
  });

  it('★ 当前色是某个预设：顺序仍是 PRESET_COLORS 原序，只标记不搬动', () => {
    // 为什么不许把当前色挪到首位：那样每次打开选单，列表顺序都会随当前色跳来
    // 跳去，用户记不住某个颜色在第几行，只能每次重新找。
    const choices = colorChoices(GREEN);
    assert.strictEqual(choices.length, PRESET_COLORS.length);
    assert.deepStrictEqual(choices.map((c) => c.hex), PRESET_COLORS);
    const marked = choices.filter((c) => c.current);
    assert.strictEqual(marked.length, 1);
    assert.strictEqual(marked[0].hex, GREEN);
  });

  it('★ 当前色的大小写与首尾空白也要命中预设（走「保持原序」那一支）', () => {
    for (const input of ['#46A758', ' #46a758 ']) {
      const choices = colorChoices(input);
      assert.strictEqual(choices.length, PRESET_COLORS.length, input);
      assert.deepStrictEqual(choices.map((c) => c.hex), PRESET_COLORS, input);
      const marked = choices.filter((c) => c.current);
      assert.strictEqual(marked.length, 1, input);
      assert.strictEqual(marked[0].hex, GREEN, input);
    }
  });

  it('★ 三位简写先展开再比对：没有简写能落进预设，所以走「自定义色」那一支', () => {
    // 3 位简写展开后三对字节各自相同（#4a7 → 44/aa/77）。8 个预设没有一个
    // 满足这一点（#ffb224 只有 ff 成对，b2/24 不成对；#46a758 三对全不成对），
    // 所以「能落进预设的简写输入」根本不存在 —— 这里钉的是「先展开再判定」
    // 这条链路，落到自定义色分支。
    const choices = colorChoices('#4a7');
    assert.strictEqual(choices.length, PRESET_COLORS.length + 1);
    assert.deepStrictEqual(choices[0], { hex: '#44aa77', current: true });
    assert.deepStrictEqual(choices.slice(1).map((c) => c.hex), PRESET_COLORS);
  });

  it('★ 当前色是自定义 hex：插到最前面，其余 8 个预设原序且都不选中', () => {
    const choices = colorChoices('#123456');
    assert.strictEqual(choices.length, PRESET_COLORS.length + 1);
    assert.deepStrictEqual(choices[0], { hex: '#123456', current: true });
    assert.deepStrictEqual(choices.slice(1).map((c) => c.hex), PRESET_COLORS);
    assert.ok(choices.slice(1).every((c) => c.current === false));
  });

  it('★ 非法当前色不抛错，按「没有当前色」处理', () => {
    // 清单文件可能被手改成垃圾值，「选颜色」这个动作不该因此整个打不开。
    for (const bad of ['#zzz', '', '  ']) {
      const choices = colorChoices(bad);
      assert.strictEqual(choices.length, PRESET_COLORS.length, JSON.stringify(bad));
      assert.deepStrictEqual(choices.map((c) => c.hex), PRESET_COLORS, JSON.stringify(bad));
      assert.ok(choices.every((c) => c.current === false), JSON.stringify(bad));
    }
  });

  it('★ 返回值是纯数据：每一项只有 hex 与 current 两个字段', () => {
    // UI 层只要这两个字段。日后想往这里塞 label / iconPath 之类，先想清楚
    // 是不是把纯函数污染成了 vscode 相关的东西。
    assert.deepStrictEqual(Object.keys(colorChoices('#123456')[0]).sort(), ['current', 'hex']);
  });
});
