import * as fs from 'fs';
import * as path from 'path';

/** 开发者任命脚本路径。组长 AI 用 `python3 <此路径> <子模块目录> <职责>` 请求创建开发者。 */
export function devRequestScriptPath(rootDir: string): string {
  return path.join(rootDir, '.society', 'create-dev.py');
}

/** 开发者任命请求数据文件（由 create-dev.py 追加、扩展消费并标记 done）。 */
export function devRequestsPath(rootDir: string): string {
  return path.join(rootDir, '.society', 'dev-requests.json');
}

/** create-dev.py 脚本内容（静态模板）。 */
export function devRequestScriptContent(): string {
  return `#!/usr/bin/env python3
"""AI society 开发者任命请求。组长用本脚本请求创建开发者，扩展定时消费。

用法：
  python3 create-dev.py <子模块目录> <职责>"""
import argparse
import json
import os
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REQUESTS = os.path.join(HERE, 'dev-requests.json')


def load():
    if not os.path.exists(REQUESTS):
        return {'requests': []}
    with open(REQUESTS, encoding='utf-8') as f:
        return json.load(f)


def save(data):
    with open(REQUESTS, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('dir')
    p.add_argument('duty')
    args = p.parse_args()

    data = load()
    req = {
        'id': uuid.uuid4().hex[:8],
        'dir': args.dir,
        'duty': args.duty,
        'status': 'pending',
    }
    data['requests'].append(req)
    save(data)
    print('已请求创建开发者 %s: %s -> %s' % (req['id'], req['duty'], req['dir']))


if __name__ == '__main__':
    main()
`;
}

/** 确保 create-dev.py 存在且内容一致（幂等）。 */
export function ensureDevRequestScript(rootDir: string): void {
  const file = devRequestScriptPath(rootDir);
  const content = devRequestScriptContent();
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    // 不存在 → 照常写
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
