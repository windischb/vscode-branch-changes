const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-changes-vscode-'));
const root = path.join(temporary, 'repository');
fs.mkdirSync(root);
const git = (...args) => execFileSync('git', args, {
  cwd: root,
  stdio: 'pipe',
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull }
});

try {
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Branch Changes Smoke Test');
  git('config', 'user.email', 'tests@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', path.join(temporary, 'no-hooks'));
  fs.writeFileSync(path.join(root, 'modified.txt'), 'original\n');
  fs.writeFileSync(path.join(root, 'deleted.txt'), 'deleted content\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
  fs.mkdirSync(path.join(root, 'context'));
  fs.writeFileSync(path.join(root, 'context', 'untouched.txt'), 'unchanged committed content\n');
  git('add', '--all');
  git('commit', '--quiet', '-m', 'base');
  git('switch', '-c', 'feature');
  fs.writeFileSync(path.join(root, 'modified.txt'), 'intermediate\n');
  git('commit', '--quiet', '-am', 'first edit');
  fs.writeFileSync(path.join(root, 'modified.txt'), 'final result\n');
  fs.writeFileSync(path.join(root, 'new #?% ü.txt'), 'added content\n');
  fs.unlinkSync(path.join(root, 'deleted.txt'));
  git('add', '--all');
  git('commit', '--quiet', '-m', 'final edit');
  // The working copy deliberately disagrees with the desired right-hand side.
  fs.writeFileSync(path.join(root, 'modified.txt'), 'uncommitted, must not appear\n');
  fs.writeFileSync(path.join(root, 'context', 'untouched.txt'), 'local edit, must not appear\n');
  fs.writeFileSync(path.join(root, 'local-only.txt'), 'local context\n');
  fs.mkdirSync(path.join(root, 'ignored'));
  fs.writeFileSync(path.join(root, 'ignored', 'cache.txt'), 'ignored context\n');

  execFileSync(process.env.VSCODE_EXECUTABLE || 'code', [
    '--wait', '--new-window', '--skip-welcome', '--skip-release-notes',
    // This disposable instance opens only the fixture generated above, never user code.
    '--disable-workspace-trust',
    `--user-data-dir=${path.join(temporary, 'user-data')}`,
    `--extensions-dir=${path.join(temporary, 'extensions')}`,
    `--extensionDevelopmentPath=${path.resolve(__dirname, '..')}`,
    `--extensionTestsPath=${path.join(__dirname, 'vscode-smoke.cjs')}`,
    root
  ], {
    stdio: 'inherit', timeout: 90000,
    env: {
      ...process.env,
      BRANCH_CHANGES_SMOKE_ROOT: root,
      BRANCH_CHANGES_SMOKE_RESULT: path.join(temporary, 'smoke-result.json')
    }
  });
  const result = JSON.parse(fs.readFileSync(path.join(temporary, 'smoke-result.json'), 'utf8'));
  assert.equal(result.passed, true, 'VS Code host must report successful assertions');
  console.log(result.message);
} catch (error) {
  const resultPath = path.join(temporary, 'smoke-result.json');
  if (fs.existsSync(resultPath)) console.error(fs.readFileSync(resultPath, 'utf8'));
  process.exitCode = 1;
  console.error(error.message);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
