const assert = require('node:assert/strict');
const { test } = require('node:test');
const { revisionUri, readRevision } = require('../src/documents');

test('virtual document identity keeps exact paths, repo and immutable commit', async () => {
  const vscode = { Uri: { from: (parts) => parts } };
  const hash = 'a'.repeat(40);
  const filePath = 'nested/ü #?%\n.txt';
  const uri = revisionUri(vscode, '/some/repo', hash, filePath);
  const content = await readRevision(uri, async (...args) => {
    assert.deepEqual(args, ['/some/repo', hash, filePath]);
    return 'committed text';
  });
  assert.equal(content, 'committed text');
  assert.notEqual(uri.query, revisionUri(vscode, '/other/repo', hash, filePath).query);
});

test('missing side is explicitly empty without running Git', async () => {
  const uri = { query: JSON.stringify({ root: '/repo', commit: null, filePath: 'new.txt' }) };
  assert.equal(await readRevision(uri, () => assert.fail('must not read absent side')), '');
});

test('invalid document requests fail rather than becoming arbitrary revisions', async () => {
  const uri = { query: JSON.stringify({ root: '/repo', commit: '--option', filePath: 'file' }) };
  await assert.rejects(readRevision(uri, () => assert.fail()), /Invalid branch comparison/);
});
