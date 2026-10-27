import * as assert from 'assert';
import { messagesPath, sendScriptPath, sendScriptContent } from '../../src/messaging';

describe('messaging', () => {
  it('send.sh 与 messages.md 路径在 society 根目录的 .society 下', () => {
    assert.strictEqual(sendScriptPath('/proj'), '/proj/.society/send.sh');
    assert.strictEqual(messagesPath('/proj'), '/proj/.society/messages.md');
  });

  it('send.sh 模板含追加消息与唤醒收件人的关键逻辑', () => {
    const c = sendScriptContent();
    assert.ok(c.includes('messages.md'));
    assert.ok(c.includes('tmux send-keys'));
    assert.ok(c.includes('>> "$MSG_FILE"'));
    assert.ok(c.includes('$#'));
  });
});
