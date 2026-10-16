const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('branch switch during a comparison cannot publish a mislabeled snapshot', async () => {
  const module = { exports: {} };
  let symbolicReads = 0;
  const originalHead = 'a'.repeat(40);
  const newHead = 'b'.repeat(40);
  const base = 'c'.repeat(40);
  const execFile = async (_executable, args) => {
    if (args[0] === 'symbolic-ref') {
      return { stdout: `${symbolicReads++ === 0 ? 'refs/heads/feature' : 'refs/heads/main'}\n` };
    }
    if (args[0] === 'rev-parse') {
      return { stdout: `${args.at(-1) === 'refs/heads/feature^{commit}' ? originalHead : newHead}\n` };
    }
    if (args[0] === 'merge-base') return { stdout: `${base}\n` };
    if (args[0] === 'diff') return { stdout: 'M\0file.txt\0' };
    assert.fail(`Unexpected Git command: ${args.join(' ')}`);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/git.js'), 'utf8'), {
    module,
    process,
    require: (name) => name === 'node:child_process' ? { execFile } : { promisify: (fn) => fn }
  });
  await assert.rejects(module.exports.getSnapshot('/repo', 'refs/heads/main'), /branch changed during comparison/);
});
