const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const manifest = require('../package.json');

test('file tree belongs to a dedicated Activity Bar container with a bundled icon', () => {
  const container = manifest.contributes.viewsContainers.activitybar.find((entry) => entry.id === 'branchChanges');
  assert.ok(container);
  assert.equal(container.title, 'Branch Changes');
  assert.ok(fs.existsSync(path.join(__dirname, '..', container.icon)));
  assert.ok(manifest.contributes.views[container.id].some((view) => view.id === 'branchChanges.files'));
  assert.equal(manifest.contributes.views.explorer, undefined);
});

test('extension package includes only explicitly approved runtime files and README', () => {
  const root = path.join(__dirname, '..');
  const rules = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').trim().split(/\r?\n/);
  const included = [
    'package.json',
    'README.md',
    'src/extension.js',
    'src/git.js',
    'src/tree.js',
    'src/documents.js',
    'media/branch-changes.svg'
  ];
  assert.deepEqual(rules, ['**', ...included.map((file) => `!${file}`)]);
  for (const file of included) assert.ok(fs.statSync(path.join(root, file)).isFile());
  assert.ok(included.includes(manifest.main.replace(/^\.\//, '')));
});

test('Git excludes local configuration and artifacts but keeps shared development files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-changes-ignore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, '..', '.gitignore'), path.join(root, '.gitignore'));
  const git = (...args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }
  });
  git('init', '--quiet', '--initial-branch=main');
  const ignored = [
    '.alta/local.json', '.env', '.env.production', 'src/.env.local',
    'debug.log', '.DS_Store', 'node_modules/example/index.js',
    'branch-changes-0.1.0.vsix', '.vscode/settings.json'
  ];
  for (const file of ignored) assert.equal(git('check-ignore', '--no-index', '--', file).trim(), file);
  for (const file of ['.vscode/launch.json', 'README.md', 'src/extension.js', 'test/git.test.js', 'scripts/smoke.cjs']) {
    assert.throws(() => git('check-ignore', '--no-index', '--', file), (error) => error.status === 1);
  }
});
