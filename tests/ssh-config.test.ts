import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { hostBlocks, simpleHost, updateSimpleHost } from '../src/ui/ssh';

test('block edits preserve global text, CRLF and adjacent Match blocks', () => {
  const text = '# global\r\nInclude extra\r\nHost dev\r\n User alice\r\nMatch all\r\n Port 22\r\n';
  const blocks = hostBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'Host dev\r\n User alice\r\n');
  assert.equal(text.slice(0, blocks[0].start), '# global\r\nInclude extra\r\n');
});

test('simple form changes preserve comments and unchanged directives', () => {
  const text = 'Host dev\r\n  User alice # owner\r\n  IdentityFile "C:\\my keys\\id"\r\n';
  const form = simpleHost(text);
  assert.ok(form);
  assert.equal(form.IdentityFile, 'C:\\my keys\\id');
  const updated = updateSimpleHost(text, { ...form, User: 'bob' });
  assert.ok(updated.includes('  User bob # owner\r\n'));
  assert.ok(updated.includes('  IdentityFile "C:\\my keys\\id"\r\n'));
  assert.equal(updated, text.replace('alice', 'bob'));
  assert.equal(simpleHost('Host *\n User root\n'), null);
  assert.equal(simpleHost('Host dev\n ProxyJump gateway\n'), null);
  assert.equal(simpleHost('Host dev\n IdentityFile a\n IdentityFile b\n'), null);
});
