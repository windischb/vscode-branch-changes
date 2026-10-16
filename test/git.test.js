const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { getBranches, getDefaultTarget, getSnapshot, parseNameStatus, getFileEntry, getTrackedFiles, getLocalFiles, readFile } = require('../src/git');

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-changes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }
  }).trim();
  const write = (name, content) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  };
  const commit = (message) => {
    git('add', '--all');
    git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Branch Changes Tests');
  git('config', 'user.email', 'tests@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.hooksPath', path.join(root, 'no-hooks'));
  return { root, git, write, commit };
}

test('one net diff over multiple commits, excluding reversions and target-only changes', async (t) => {
  const { root, git, write, commit } = repository(t);
  write('src/repeated.txt', 'original\n');
  write('reverted.txt', 'keep\n');
  const base = commit('base');
  git('switch', '-c', 'feature');
  write('src/repeated.txt', 'first edit\n');
  write('reverted.txt', 'temporary\n');
  write('temporary.txt', 'temporary\n');
  commit('first edit');
  write('src/repeated.txt', 'final result\n');
  write('reverted.txt', 'keep\n');
  fs.unlinkSync(path.join(root, 'temporary.txt'));
  const head = commit('final edit');
  git('switch', 'main');
  write('src/repeated.txt', 'target-only edit\n');
  write('target-only.txt', 'not in this PR\n');
  commit('main advances');
  git('switch', 'feature');

  // Staged, unstaged and untracked files must never enter the snapshot.
  write('staged.txt', 'local only\n');
  git('add', 'staged.txt');
  write('src/repeated.txt', 'uncommitted\n');
  write('untracked.txt', 'local only\n');
  const snapshot = await getSnapshot(root, 'refs/heads/main');
  assert.equal(snapshot.base, base);
  assert.equal(snapshot.head, head);
  assert.deepEqual(snapshot.files, [{ status: 'M', path: 'src/repeated.txt', oldPath: 'src/repeated.txt' }]);
  assert.equal(await readFile(root, base, 'src/repeated.txt'), 'original\n');
  assert.equal(await readFile(root, head, 'src/repeated.txt'), 'final result\n');
});

test('added, deleted and renamed files preserve exact unusual paths and content', async (t) => {
  const { root, git, write, commit } = repository(t);
  const oldName = 'nested/old\tname.txt';
  const newName = 'nested/new\nname #?% ü.txt';
  write(oldName, 'same content\n');
  write('deleted.txt', 'gone\n');
  commit('base');
  git('switch', '-c', 'feature');
  fs.renameSync(path.join(root, oldName), path.join(root, newName));
  fs.unlinkSync(path.join(root, 'deleted.txt'));
  write('-[literal]*.txt', 'added\n');
  write('empty.txt', '');
  commit('rename add delete');
  const snapshot = await getSnapshot(root, 'refs/heads/main');
  assert.deepEqual(snapshot.files.find((file) => file.status === 'R'), { status: 'R', oldPath: oldName, path: newName });
  assert.equal(snapshot.files.filter((file) => file.status === 'A').length, 2);
  assert.ok(snapshot.files.some((file) => file.status === 'D' && file.path === 'deleted.txt'));
  assert.equal(await readFile(root, snapshot.base, oldName), 'same content\n');
  assert.equal(await readFile(root, snapshot.head, newName), 'same content\n');
  assert.equal(await readFile(root, snapshot.head, '-[literal]*.txt'), 'added\n');
  assert.equal(await readFile(root, snapshot.head, 'empty.txt'), '');
  await assert.rejects(readFile(root, snapshot.head, 'deleted.txt'), /Cannot read/);
});

test('snapshots remain immutable after HEAD moves; equal branches are empty', async (t) => {
  const { root, git, write, commit } = repository(t);
  write('file.txt', 'base\n');
  commit('base');
  assert.deepEqual((await getSnapshot(root, 'refs/heads/main')).files, []);
  git('switch', '-c', 'feature');
  write('file.txt', 'version one\n');
  commit('first');
  const snapshot = await getSnapshot(root, 'refs/heads/main');
  write('file.txt', 'version two\n');
  commit('second');
  assert.equal(await readFile(root, snapshot.head, 'file.txt'), 'version one\n');
});

test('binary content is reported explicitly rather than decoded as a text diff', async (t) => {
  const { root, write, commit } = repository(t);
  write('binary.dat', Buffer.from([0, 1, 2, 255]));
  const head = commit('binary');
  await assert.rejects(readFile(root, head, 'binary.dat'), /Binary file.*text diffs only/);
});

test('symlinks, executable-bit changes, and submodules are not working-tree files', async (t) => {
  const { root, git, write, commit } = repository(t);
  write('script.sh', '#!/bin/sh\n');
  const base = commit('base');
  git('switch', '-c', 'feature');
  git('config', 'core.filemode', 'true');
  fs.chmodSync(path.join(root, 'script.sh'), 0o755);
  fs.symlinkSync('missing-target', path.join(root, 'link'));
  git('add', '--all');
  // A gitlink can be tested without cloning or fetching a real submodule.
  git('update-index', '--add', '--cacheinfo', `160000,${base},submodule`);
  git('commit', '--quiet', '-m', 'types and modes');
  const snapshot = await getSnapshot(root, 'refs/heads/main');
  assert.ok(snapshot.files.some((file) => file.path === 'script.sh' && file.status === 'M'));
  assert.equal((await getFileEntry(root, snapshot.base, 'script.sh')).mode, '100644');
  assert.equal((await getFileEntry(root, snapshot.head, 'script.sh')).mode, '100755');
  assert.equal(await readFile(root, snapshot.head, 'link'), 'missing-target');
  assert.equal(await readFile(root, snapshot.head, 'submodule'), `Subproject commit ${base}\n`);
});

test('branch listing distinguishes local/remote branches and ignores symbolic aliases', async (t) => {
  const { root, git, write, commit } = repository(t);
  write('file', 'base');
  const base = commit('base');
  git('switch', '-c', 'feature');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const branches = await getBranches(root);
  assert.ok(branches.some((branch) => branch.ref === 'refs/heads/main' && !branch.remote));
  assert.ok(branches.some((branch) => branch.ref === 'refs/remotes/origin/main' && branch.remote));
  assert.ok(!branches.some((branch) => branch.label === 'origin/HEAD'));
  assert.equal(await getDefaultTarget(root, branches), 'refs/remotes/origin/main');
});

test('unborn, missing target and unrelated histories fail instead of returning empty results', async (t) => {
  const { root, git, write, commit } = repository(t);
  await assert.rejects(getSnapshot(root, 'refs/heads/main'));
  write('file', 'base');
  commit('base');
  await assert.rejects(getSnapshot(root, 'refs/heads/missing'));
  git('switch', '--orphan', 'unrelated');
  write('other', 'unrelated');
  commit('unrelated root');
  await assert.rejects(getSnapshot(root, 'refs/heads/main'), /No common ancestor/);
});

test('NUL parser handles type changes and rejects incomplete rename records', () => {
  assert.deepEqual(parseNameStatus('T\0link\0R095\0old\tname\0new\nname\0'), [
    { status: 'T', path: 'link', oldPath: 'link' },
    { status: 'R', path: 'new\nname', oldPath: 'old\tname' }
  ]);
  assert.deepEqual(parseNameStatus(''), []);
  assert.throws(() => parseNameStatus('R100\0old\0'), /Invalid file list/);
});

test('ambiguous criss-cross merge history is reported explicitly', async (t) => {
  const { root, git, write, commit } = repository(t);
  write('base', 'base');
  const base = commit('base');
  const tree = git('rev-parse', `${base}^{tree}`);
  const left = git('commit-tree', tree, '-p', base, '-m', 'left');
  const right = git('commit-tree', tree, '-p', base, '-m', 'right');
  const firstMerge = git('commit-tree', tree, '-p', left, '-p', right, '-m', 'first merge');
  const secondMerge = git('commit-tree', tree, '-p', right, '-p', left, '-m', 'second merge');
  git('update-ref', 'refs/heads/main', firstMerge);
  git('update-ref', 'refs/heads/feature', secondMerge);
  git('switch', 'feature');
  await assert.rejects(getSnapshot(root, 'refs/heads/main'), /Multiple common ancestors/);
});

test('full file list uses an exact commit and excludes staged, untracked and ignored files', async (t) => {
  const { root, git, write, commit } = repository(t);
  const special = 'nested/ leading\tname #?% ü\n ';
  write('untouched.txt', 'stable\n');
  write(special, 'unusual name\n');
  write('.gitignore', 'ignored/\n');
  fs.symlinkSync('missing-target', path.join(root, 'link'));
  const head = commit('committed context');
  git('update-index', '--add', '--cacheinfo', `160000,${head},submodule`);
  git('commit', '--quiet', '-m', 'submodule');
  const withSubmodule = git('rev-parse', 'HEAD');
  write('later.txt', 'newer commit\n');
  commit('advance HEAD');
  write('staged.txt', 'local staged\n');
  git('add', 'staged.txt');
  write('untracked.txt', 'local untracked\n');
  write('ignored/cache.txt', 'generated\n');
  write('untouched.txt', 'uncommitted edit\n');
  fs.unlinkSync(path.join(root, special));

  const paths = await getTrackedFiles(root, withSubmodule);
  assert.deepEqual(paths.sort(), ['.gitignore', 'untouched.txt', special, 'link', 'submodule'].sort());
  assert.equal(await readFile(root, withSubmodule, 'untouched.txt'), 'stable\n');
  assert.equal(await readFile(root, withSubmodule, special), 'unusual name\n');
  assert.ok(!paths.some((filePath) => filePath.startsWith('submodule/')));
});

test('local context honors all Git ignore sources and optionally includes ignored files', async (t) => {
  const { root, git, write, commit } = repository(t);
  write('tracked.txt', 'committed\n');
  commit('base');
  write('.gitignore', 'ignored/\n*.log\n!important.log\ntracked.txt\nstaged-ignored.txt\n');
  write('.git/info/exclude', 'info-excluded.txt\n');
  write('.git/test-global-excludes', 'global-excluded.txt\n');
  git('config', 'core.excludesFile', path.join(root, '.git/test-global-excludes'));
  const special = 'local/ name\t#?% ü\n ';
  write(special, 'local\n');
  write('staged.txt', 'staged\n');
  write('staged-ignored.txt', 'staged despite ignore\n');
  write('missing-staged.txt', 'later deleted\n');
  git('add', '--force', 'staged.txt', 'staged-ignored.txt', 'missing-staged.txt');
  fs.unlinkSync(path.join(root, 'missing-staged.txt'));
  write('important.log', 'negated ignore pattern\n');
  write('hidden.log', 'ignored\n');
  write('ignored/deep/generated.txt', 'ignored directory\n');
  write('info-excluded.txt', 'info exclude\n');
  write('global-excluded.txt', 'global exclude\n');

  const normal = await getLocalFiles(root);
  const normalPaths = normal.map((file) => file.path);
  for (const filePath of [special, 'tracked.txt', 'staged.txt', 'staged-ignored.txt', 'important.log']) {
    assert.ok(normalPaths.includes(filePath), filePath);
  }
  for (const filePath of ['missing-staged.txt', 'hidden.log', 'ignored/deep/generated.txt', 'info-excluded.txt', 'global-excluded.txt']) {
    assert.ok(!normalPaths.includes(filePath), filePath);
  }
  assert.ok(normal.every((file) => file.local && !file.ignored && !file.status));
  const all = await getLocalFiles(root, true);
  for (const filePath of ['hidden.log', 'ignored/deep/generated.txt', 'info-excluded.txt', 'global-excluded.txt']) {
    assert.ok(all.some((file) => file.path === filePath && file.ignored), filePath);
  }
  assert.equal(all.filter((file) => file.path === 'tracked.txt').length, 1);
  assert.ok(!all.some((file) => /(^|\/)\.git(\/|$)/i.test(file.path)));
});

test('local enumeration never traverses nested repositories or submodules', async (t) => {
  const { root, git, write, commit } = repository(t);
  write('base.txt', 'base');
  const head = commit('base');
  git('init', '--quiet', path.join(root, 'nested'));
  write('nested/private.txt', 'separate repository\n');
  git('init', '--quiet', '--separate-git-dir', path.join(root, '.git/linked-metadata'), path.join(root, 'linked'));
  write('linked/private.txt', 'separate gitdir-file repository\n');
  write('submodule/private.txt', 'submodule working copy\n');
  git('update-index', '--add', '--cacheinfo', `160000,${head},submodule`);
  const local = await getLocalFiles(root, true);
  assert.ok(!local.some((file) => file.path === 'submodule'), 'Staged gitlinks must not become local file leaves');
  assert.ok(!local.some((file) => /^(nested|linked|submodule)\//.test(file.path)));
  assert.ok(!local.some((file) => /(^|\/)\.git(\/|$)/i.test(file.path)));
});
