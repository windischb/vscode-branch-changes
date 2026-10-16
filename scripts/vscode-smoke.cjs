const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');
const { getSnapshot } = require('../src/git');

async function run() {
  const projectRoot = path.resolve(__dirname, '..');
  const extension = vscode.extensions.all.find((entry) => entry.extensionPath === projectRoot);
  assert.ok(extension, 'Development extension must be discoverable');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['refresh', 'selectTarget', 'selectRepository', 'openDiff', 'openFile', 'showAllFiles', 'showChangesOnly', 'showIgnoredFiles', 'hideIgnoredFiles']) {
    assert.ok(commands.includes(`branchChanges.${command}`), `${command} must be registered`);
  }
  const containerCommand = 'workbench.view.extension.branchChanges';
  assert.ok(commands.includes(containerCommand), 'Dedicated Activity Bar container must be registered');
  await vscode.commands.executeCommand(containerCommand);
  await vscode.commands.executeCommand('branchChanges.files.focus');
  await vscode.commands.executeCommand('branchChanges.refresh');
  await vscode.commands.executeCommand('branchChanges.showChangesOnly');
  await vscode.commands.executeCommand('branchChanges.showAllFiles');

  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  assert.equal(root, process.env.BRANCH_CHANGES_SMOKE_ROOT, 'Only the disposable fixture created by smoke.cjs may be mutated');
  const snapshot = await getSnapshot(root, 'refs/heads/main');
  assert.equal(snapshot.files.length, 3);
  for (const file of snapshot.files) {
    await vscode.commands.executeCommand('branchChanges.openDiff', file, snapshot);
    const input = vscode.window.tabGroups.activeTabGroup.activeTab.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, 'Must open a native text diff');
    const before = await vscode.workspace.openTextDocument(input.original);
    const after = await vscode.workspace.openTextDocument(input.modified);
    assert.equal(before.isDirty, false);
    assert.equal(after.isDirty, false);
    assert.equal(input.original.scheme, 'branch-changes');
    assert.equal(input.modified.scheme, 'branch-changes');
    if (file.status === 'A') {
      assert.equal(before.getText(), '');
      assert.equal(after.getText(), 'added content\n');
      assert.equal(JSON.parse(input.modified.query).filePath, 'new #?% ü.txt');
    } else if (file.status === 'D') {
      assert.equal(before.getText(), 'deleted content\n');
      assert.equal(after.getText(), '');
    } else {
      assert.equal(before.getText(), 'original\n');
      assert.equal(after.getText(), 'final result\n');
    }
    assert.notEqual(vscode.workspace.fs.isWritableFileSystem('branch-changes'), true);
    await vscode.commands.executeCommand('workbench.action.keepEditor');
  }
  await vscode.commands.executeCommand('branchChanges.openFile', { path: 'context/untouched.txt', status: '' }, snapshot);
  const unchangedInput = vscode.window.tabGroups.activeTabGroup.activeTab.input;
  assert.ok(unchangedInput instanceof vscode.TabInputText, 'Unchanged file must open a single committed document, not a diff');
  assert.equal(unchangedInput.uri.scheme, 'branch-changes');
  assert.equal(JSON.parse(unchangedInput.uri.query).commit, snapshot.head);
  const unchangedDocument = await vscode.workspace.openTextDocument(unchangedInput.uri);
  assert.equal(unchangedDocument.getText(), 'unchanged committed content\n');

  const tabKeys = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).map((tab) => {
    if (tab.input instanceof vscode.TabInputTextDiff) return `diff:${tab.input.original}:${tab.input.modified}`;
    if (tab.input instanceof vscode.TabInputText) return `file:${tab.input.uri}`;
    return `other:${tab.label}`;
  });
  const originalTabs = tabKeys();
  const assertRetainedTabs = () => {
    const current = tabKeys();
    for (const key of originalTabs) assert.ok(current.includes(key), `Refresh must retain ${key}`);
    assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.input.uri.toString(), unchangedInput.uri.toString());
  };
  await vscode.commands.executeCommand('branchChanges.showIgnoredFiles');
  assertRetainedTabs();
  await vscode.commands.executeCommand('branchChanges.hideIgnoredFiles');
  assertRetainedTabs();

  // Exercise Git-state refresh plus an explicit completion barrier, with pinned
  // diffs and an unpinned preview still open. No user repository is touched.
  const gitExtension = await vscode.extensions.getExtension('vscode.git').activate();
  const repository = gitExtension.getAPI(1).getRepository(vscode.Uri.file(root));
  assert.ok(repository, 'Fixture repository must be discovered by the built-in Git extension');
  const changedHead = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listener.dispose(); reject(new Error('Git state did not update after fixture commit')); }, 10000);
    const listener = repository.state.onDidChange(() => {
      if (repository.state.HEAD?.commit && repository.state.HEAD.commit !== snapshot.head) {
        clearTimeout(timer);
        listener.dispose();
        resolve();
      }
    });
  });
  fs.writeFileSync(path.join(root, 'modified.txt'), 'new committed result\n');
  fs.unlinkSync(path.join(root, 'context', 'untouched.txt'));
  execFileSync('git', ['add', '--', 'modified.txt', 'context/untouched.txt'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['commit', '--quiet', '-m', 'refresh fixture'], { cwd: root, stdio: 'pipe' });
  await changedHead;
  await vscode.commands.executeCommand('branchChanges.refresh');
  assertRetainedTabs();
  assert.equal(unchangedDocument.getText(), 'unchanged committed content\n', 'A deleted file remains available in its historical tab');

  await vscode.commands.executeCommand('branchChanges.openFile', { path: 'local-only.txt', local: true }, snapshot);
  const localInput = vscode.window.tabGroups.activeTabGroup.activeTab.input;
  assert.ok(localInput instanceof vscode.TabInputText);
  assert.equal(localInput.uri.scheme, 'file');
  assert.equal((await vscode.workspace.openTextDocument(localInput.uri)).getText(), 'local context\n');

  const message = 'Branch Changes: view/ignore modes, native diffs, retained editor tabs after Git changes, immutable deleted documents and local opening passed.';
  fs.writeFileSync(path.join(path.dirname(root), 'smoke-result.json'), JSON.stringify({ passed: true, message }));
  console.log(message);
}

exports.run = async function () {
  try {
    await run();
  } catch (error) {
    fs.writeFileSync(process.env.BRANCH_CHANGES_SMOKE_RESULT, JSON.stringify({
      passed: false,
      message: error.stack,
      trusted: vscode.workspace.isTrusted,
      folders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString()),
      git: vscode.extensions.all.filter((entry) => entry.id.includes('git')).map((entry) => entry.id)
    }));
    throw error;
  }
};
