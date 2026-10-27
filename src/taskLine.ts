import * as fs from 'fs';
import * as path from 'path';

/** 任务线脚本路径。AI 用 `python3 <此路径> ...` 读写任务，禁止直接改 tasks.json。 */
export function taskScriptPath(rootDir: string): string {
  return path.join(rootDir, '.society', 'task.py');
}

/** 任务线数据文件路径（由 task.py 独占，AI 不直接碰）。 */
export function taskFilePath(rootDir: string): string {
  return path.join(rootDir, '.society', 'tasks.json');
}

/** task.py 脚本内容（静态模板）。 */
export function taskScriptContent(): string {
  return `#!/usr/bin/env python3
"""AI society 任务线。用本脚本读写任务，不要直接改 tasks.json。

用法：
  python3 task.py add <标题> [--level outline|module] [--parent <任务id>] [--assignee <层级>]
  python3 task.py list [--status todo|doing|done|rejected]
  python3 task.py update <任务id> <todo|doing|done|rejected>

粗纲用 outline，细粒度模块用 module。"""
import argparse
import json
import os
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
TASKS = os.path.join(HERE, 'tasks.json')


def load():
    if not os.path.exists(TASKS):
        return {'tasks': []}
    with open(TASKS, encoding='utf-8') as f:
        return json.load(f)


def save(data):
    with open(TASKS, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def add(args):
    data = load()
    t = {
        'id': uuid.uuid4().hex[:8],
        'title': args.title,
        'level': args.level,
        'parent': args.parent,
        'assignee': args.assignee,
        'status': 'todo',
    }
    data['tasks'].append(t)
    save(data)
    print('已添加任务 %s: %s' % (t['id'], t['title']))


def list_tasks(args):
    tasks = load()['tasks']
    if args.status:
        tasks = [t for t in tasks if t['status'] == args.status]
    for t in tasks:
        parent = (' (父:%s)' % t['parent']) if t['parent'] else ''
        print('[%s] %s [%s] %s%s' % (t['status'], t['id'], t['level'], t['title'], parent))


def update(args):
    data = load()
    for t in data['tasks']:
        if t['id'] == args.id:
            t['status'] = args.status
            save(data)
            print('任务 %s -> %s' % (t['id'], t['status']))
            return
    print('找不到任务 %s' % args.id, file=sys.stderr)
    sys.exit(1)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='cmd', required=True)

    a = sub.add_parser('add')
    a.add_argument('title')
    a.add_argument('--level', default='outline', choices=['outline', 'module'])
    a.add_argument('--parent')
    a.add_argument('--assignee')
    a.set_defaults(fn=add)

    l = sub.add_parser('list')
    l.add_argument('--status', choices=['todo', 'doing', 'done', 'rejected'])
    l.set_defaults(fn=list_tasks)

    u = sub.add_parser('update')
    u.add_argument('id')
    u.add_argument('status', choices=['todo', 'doing', 'done', 'rejected'])
    u.set_defaults(fn=update)

    args = p.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
`;
}

/** 确保任务线脚本存在且内容一致（幂等）。 */
export function ensureTaskScript(rootDir: string): void {
  const file = taskScriptPath(rootDir);
  const content = taskScriptContent();
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    // 不存在 → 照常写
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
