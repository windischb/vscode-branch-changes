const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildTree } = require('../src/tree');

test('one sorted tree groups paths while preserving original records', () => {
  const files = [
    { path: 'z.txt', oldPath: 'z.txt', status: 'M' },
    { path: 'src/z.js', oldPath: 'old.js', status: 'R' },
    { path: 'src/a.js', oldPath: 'src/a.js', status: 'A' },
    { path: 'a.txt', oldPath: 'a.txt', status: 'D' }
  ];
  const tree = buildTree(files);
  assert.deepEqual(tree.map((node) => node.label), ['src', 'a.txt', 'z.txt']);
  assert.deepEqual(tree[0].children.map((node) => node.label), ['a.js', 'z.js']);
  assert.equal(tree[0].children[1].oldPath, 'old.js');
  assert.equal(files.length, 4);
});

test('deleted file and added directory with the same name are separate tree nodes', () => {
  const tree = buildTree([
    { path: 'name', oldPath: 'name', status: 'D' },
    { path: 'name/file.txt', oldPath: 'name/file.txt', status: 'A' }
  ]);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].kind, 'folder');
  assert.equal(tree[1].kind, 'file');
  assert.equal(tree[0].children[0].path, 'name/file.txt');
});

test('full tree overlays net changes once and highlights only affected ancestor paths', () => {
  const unchanged = (filePath) => ({ path: filePath, oldPath: filePath, status: '' });
  const tree = buildTree([
    { path: 'src/deep/changed.ts', oldPath: 'src/deep/changed.ts', status: 'M' },
    { path: 'src/new.ts', oldPath: 'src/new.ts', status: 'A' },
    { path: 'src/renamed.ts', oldPath: 'old/location.ts', status: 'R' },
    { path: 'removed/only.txt', oldPath: 'removed/only.txt', status: 'D' }
  ], [
    unchanged('src/deep/changed.ts'), unchanged('src/new.ts'), unchanged('src/renamed.ts'),
    unchanged('src/deep/untouched.ts'), unchanged('src/quiet/sibling.ts'), unchanged('docs/readme.md')
  ]);
  const docs = tree.find((node) => node.path === 'docs');
  const src = tree.find((node) => node.path === 'src');
  const removed = tree.find((node) => node.path === 'removed');
  assert.equal(docs.changed, false);
  assert.equal(docs.children[0].changed, false);
  assert.equal(src.changed, true);
  const deep = src.children.find((node) => node.path === 'src/deep');
  assert.equal(deep.changed, true);
  assert.equal(deep.children.find((node) => node.path.endsWith('untouched.ts')).changed, false);
  assert.equal(src.children.find((node) => node.path === 'src/quiet').changed, false);
  assert.equal(src.children.filter((node) => node.path === 'src/new.ts').length, 1);
  const renamed = src.children.find((node) => node.status === 'R');
  assert.equal(renamed.oldPath, 'old/location.ts');
  assert.equal(removed.changed, true);
  assert.equal(removed.children[0].status, 'D');
  assert.ok(!tree.some((node) => node.path === 'old'), 'Renamed source should not be added as a second file');
});

test('unchanged siblings never clear a folder highlight, regardless of insertion order', () => {
  const changed = { path: 'src/changed.txt', oldPath: 'src/changed.txt', status: 'M' };
  const untouched = { path: 'src/untouched.txt', oldPath: 'src/untouched.txt', status: '' };
  for (const files of [[changed, untouched], [untouched, changed]]) {
    assert.equal(buildTree(files)[0].changed, true);
  }
});

test('full tree preserves a new file replacing a deleted directory', () => {
  const tree = buildTree([
    { path: 'name/file.txt', oldPath: 'name/file.txt', status: 'D' },
    { path: 'name', oldPath: 'name', status: 'A' }
  ], [{ path: 'name', oldPath: 'name', status: '' }]);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].kind, 'folder');
  assert.equal(tree[1].kind, 'file');
  assert.equal(tree[0].changed, true);
  assert.equal(tree[1].status, 'A');
});

test('tree provenance and local-only folder metadata stay distinct from committed changes', () => {
  const context = [
    { path: 'local/new.txt', oldPath: 'local/new.txt', status: '', local: true, ignored: false },
    { path: 'ignored/cache.txt', oldPath: 'ignored/cache.txt', status: '', local: true, ignored: true },
    { path: 'mixed/local.txt', oldPath: 'mixed/local.txt', status: '', local: true },
    { path: 'mixed/committed.txt', oldPath: 'mixed/committed.txt', status: '' }
  ];
  const tree = buildTree([], context, { repositoryRoot: '/repo', publication: 12 });
  assert.ok(tree.every((node) => !node.changed && node.repositoryRoot === '/repo' && node.publication === 12));
  assert.equal(tree.find((node) => node.path === 'local').localOnly, true);
  assert.equal(tree.find((node) => node.path === 'local').ignoredOnly, false);
  assert.equal(tree.find((node) => node.path === 'ignored').ignoredOnly, true);
  assert.equal(tree.find((node) => node.path === 'mixed').localOnly, false);
  assert.ok(tree.flatMap((node) => node.children).every((node) => node.publication === 12));
});
