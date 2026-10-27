import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  devRequestScriptPath,
  devRequestScriptContent,
  devRequestsPath,
  ensureDevRequestScript,
} from '../../src/devRequest';

describe('devRequest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devrequest-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('脚本与请求文件路径在 society 根目录的 .society 下', () => {
    assert.strictEqual(devRequestScriptPath('/proj'), '/proj/.society/create-dev.py');
    assert.strictEqual(devRequestsPath('/proj'), '/proj/.society/dev-requests.json');
  });

  it('create-dev.py 模板含 dir/duty 位置参数与 pending 状态', () => {
    const c = devRequestScriptContent();
    assert.ok(c.includes('create-dev.py'));
    assert.ok(c.includes('dev-requests.json'));
    assert.ok(c.includes("add_argument('dir')"));
    assert.ok(c.includes("add_argument('duty')"));
    assert.ok(c.includes("'requests'"));
    assert.ok(c.includes("'pending'"));
  });

  it('ensureDevRequestScript 幂等落盘，内容与模板一致', () => {
    ensureDevRequestScript(tmpDir);
    const file = devRequestScriptPath(tmpDir);
    assert.ok(fs.existsSync(file));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), devRequestScriptContent());
    // 再跑一次不应报错、内容不变。
    ensureDevRequestScript(tmpDir);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), devRequestScriptContent());
  });
});
