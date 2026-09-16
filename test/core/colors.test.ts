import * as assert from 'assert';
import { PRESET_COLORS, colorBarSvg, normalizeHexColor } from '../../src/core/colors';

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
