import * as fs from 'fs';
import * as path from 'path';

/** 消息文件在 society 根目录 `.society/` 下的位置（发消息脚本与它同目录）。 */
export function messagesPath(rootDir: string): string {
  return path.join(rootDir, '.society', 'messages.md');
}

/** 发消息脚本路径。AI 用 `bash <此路径> ...` 调用。 */
export function sendScriptPath(rootDir: string): string {
  return path.join(rootDir, '.society', 'send.sh');
}

/**
 * 发消息脚本内容（静态模板）。AI society 里的角色靠它给其他角色发消息：
 * 追加一条消息到 messages.md，再 tmux send-keys 唤醒收件人的 claude 会话。
 * 只发固定提示、全文留 messages.md —— 避免 tmux send-keys 的多行/引号转义问题。
 */
export function sendScriptContent(): string {
  return [
    '#!/usr/bin/env bash',
    '# AI society 消息发送：追加一条消息到 messages.md，并唤醒收件人的 claude 会话。',
    '# 用法：bash send.sh <发件人名称> <收件人终端ID> <消息文本>',
    'set -euo pipefail',
    '',
    'if [ "$#" -lt 3 ]; then',
    '  echo "用法：bash send.sh <发件人名称> <收件人终端ID> <消息文本>" >&2',
    '  exit 1',
    'fi',
    '',
    'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    'MSG_FILE="$DIR/messages.md"',
    'FROM="$1"',
    'TO="$2"',
    'BODY="$3"',
    "TS=\"$(date '+%Y-%m-%d %H:%M:%S')\"",
    '',
    '{',
    '  echo',
    '  echo "## $TS · $FROM → $TO"',
    '  echo',
    '  echo "$BODY"',
    '} >> "$MSG_FILE"',
    '',
    '# 只发固定提示唤醒收件人；消息全文在 messages.md，避免 send-keys 转义问题。',
    'tmux send-keys -t "=$TO:" "[society] 你有一条新消息" C-m',
    '',
  ].join('\n');
}

/** 确保发消息脚本存在且内容一致（幂等）。AI 每次靠它发消息，被手删了就补。 */
export function ensureSendScript(rootDir: string): void {
  const file = sendScriptPath(rootDir);
  const content = sendScriptContent();
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    // 不存在 → 照常写
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
