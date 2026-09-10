/**
 * 为每个 cwd 生成尽量短、且彼此可区分的显示名。
 *
 * 规则：从 basename 起，若与他人冲突就往上多带一层父目录，直到唯一。
 * 已经到根仍冲突（例如多条 cwd **逐字节相同**）则退回**最短的**候选
 * （即 basename）—— 必须终止，不能死循环。
 *
 * 为什么退回 basename 而不是完整路径：同目录的条目本来就靠**行标签**
 * （条目名）区分，描述只是辅助。退回完整路径会让描述「占宽又难扫」，
 * 恰恰把本功能的意义反过来 —— 而相同 cwd 无论怎么加长都无法唯一。
 *
 * 只做展示用途，不参与任何路径解析，所以不做权威的路径规范化；
 * 仅去掉末尾斜杠，避免 `/a/b/` 与 `/a/b` 被误判为不同名。
 */

function segments(p: string): string[] {
  return p.replace(/\/+$/, '').split('/').filter((s) => s.length > 0);
}

export function shortLabels(cwds: string[]): string[] {
  const parts = cwds.map(segments);
  return parts.map((seg, i) => {
    // 逐层加长，直到该长度在所有人里唯一
    for (let take = 1; take <= seg.length; take++) {
      const candidate = seg.slice(seg.length - take).join('/');
      const clash = parts.some((other, j) => {
        if (i === j) return false;
        const otherCand = other.slice(Math.max(0, other.length - take)).join('/');
        return otherCand === candidate;
      });
      if (!clash) return candidate;
    }
    // 到根仍冲突（例如两条 cwd 逐字节相同，或都是 "/"）→ 退回最短候选。
    // seg 为空（如 "/"）时 slice 得空串，回退为 "/"，仍然非空且合理。
    const shortest = seg.slice(Math.max(0, seg.length - 1)).join('/');
    return shortest.length > 0 ? shortest : '/';
  });
}
