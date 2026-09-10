/**
 * 为每个 cwd 生成尽量短、且彼此可区分的显示名。
 *
 * 规则：从 basename 起，若与他人冲突就往上多带一层父目录，直到唯一。
 * 已经到根仍冲突则退回完整路径 —— 必须终止，不能死循环。
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
    // 到根仍冲突（例如两条都是 "/"）→ 退回完整路径
    const full = cwds[i];
    return full.length > 0 ? full : '/';
  });
}
