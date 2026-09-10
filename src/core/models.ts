/**
 * 解析 claude settings JSON 里的模型清单。
 *
 * 复用用户已维护的 `availableModels`（全局 settings 里已有 13 个），
 * 而不是让扩展自带一份 —— 两处维护必然不同步。
 *
 * 一律宽容：settings 损坏不该让扩展功能不可用。
 */

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    return v as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function parseAvailableModels(raw: string): string[] {
  const o = parseObject(raw);
  if (o === undefined) return [];
  const list = o.availableModels;
  if (!Array.isArray(list)) return [];
  return list.filter((m): m is string => typeof m === 'string' && m.length > 0);
}

export function parseDefaultModel(raw: string): string | undefined {
  const o = parseObject(raw);
  if (o === undefined) return undefined;
  const m = o.model;
  return typeof m === 'string' && m.length > 0 ? m : undefined;
}
