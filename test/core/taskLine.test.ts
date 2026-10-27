import * as assert from 'assert';
import { taskFilePath, taskScriptPath, taskScriptContent } from '../../src/taskLine';

describe('taskLine', () => {
  it('task.py 与 tasks.json 路径在 society 根目录的 .society 下', () => {
    assert.strictEqual(taskScriptPath('/proj'), '/proj/.society/task.py');
    assert.strictEqual(taskFilePath('/proj'), '/proj/.society/tasks.json');
  });

  it('task.py 模板含 add/list/update 三个子命令', () => {
    const c = taskScriptContent();
    assert.ok(c.includes('add_parser'));
    assert.ok(c.includes("choices=['outline', 'module']"));
    assert.ok(c.includes("choices=['todo', 'doing', 'done', 'rejected']"));
    assert.ok(c.includes('tasks.json'));
  });
});
