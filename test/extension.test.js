const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, options = {}) {
  const disposable = { dispose() {} };
  const repositoryEvents = new Map();
  const repository = (root) => ({
    rootUri: { fsPath: root },
    state: { onDidChange: (listener) => { repositoryEvents.set(root, listener); return disposable; } }
  });
  const api = {
    repositories: [repository('/first/repo'), repository('/second/repo')],
    onDidOpenRepository: () => disposable,
    onDidCloseRepository: () => disposable
  };
  const stored = new Map(options.stored || []);
  if (Object.hasOwn(options, 'showAllFiles')) stored.set('branchChanges.showAllFiles', options.showAllFiles);
  const context = {
    subscriptions: [],
    workspaceState: {
      get: (key, fallback) => stored.has(key) ? stored.get(key) : key.startsWith('branchChanges.target:') ? 'refs/heads/main' : fallback,
      update: async (key, value) => { stored.set(key, value); }
    }
  };
  const branches = [
    { ref: 'refs/heads/main', label: 'main' },
    { ref: 'refs/heads/other', label: 'other' }
  ];
  const snapshot = (root, targetRef) => ({
    root, targetRef, base: 'a'.repeat(40), head: 'b'.repeat(40), branch: 'feature',
    files: [{ status: 'M', path: 'file.txt', oldPath: 'file.txt' }]
  });
  const git = {
    getBranches: async () => branches,
    getSnapshot: async (root, target) => snapshot(root, target),
    getTrackedFiles: async () => ['file.txt', 'untouched.txt'],
    getLocalFiles: async () => []
  };
  let controller;
  let decorations;
  const viewEvents = {};
  const treeEvents = [];
  const commands = [];
  const vscode = {
    EventEmitter: class {
      event = () => disposable;
      fire() { treeEvents.push(controller?.children); }
      dispose() {}
    },
    TreeItem: class {
      constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; }
    },
    TreeItemCollapsibleState: { Expanded: 2, Collapsed: 1, None: 0 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    Uri: {
      from: (parts) => parts,
      file: (filePath) => ({ scheme: 'file', path: filePath }),
      joinPath: (uri, filePath) => ({ ...uri, path: `${uri.path}/${filePath}` })
    },
    extensions: { getExtension: () => ({ activate: async () => ({ enabled: true, getAPI: () => api }) }) },
    commands: { registerCommand: () => disposable, executeCommand: async (...args) => { commands.push(args); } },
    workspace: { registerTextDocumentContentProvider: () => disposable },
    window: {
      registerFileDecorationProvider: (provider) => {
        decorations = provider;
        return disposable;
      },
      createTreeView: (_id, options) => {
        controller = options.treeDataProvider;
        return {
          ...disposable,
          onDidExpandElement: (listener) => { viewEvents.expand = listener; return disposable; },
          onDidCollapseElement: (listener) => { viewEvents.collapse = listener; return disposable; }
        };
      },
      showQuickPick: async () => undefined,
      showErrorMessage: (message) => assert.fail(message)
    }
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
  vm.runInNewContext(source, {
    require: (name) => name === 'vscode' ? vscode : name === './git' ? {
      ...git,
      getSnapshot: (...args) => git.getSnapshot(...args),
      getTrackedFiles: (...args) => git.getTrackedFiles(...args),
      getLocalFiles: (...args) => git.getLocalFiles(...args)
    } :
      name.startsWith('./') ? require(`../src/${name.slice(2)}`) : require(name),
    module, setTimeout, clearTimeout
  });
  await module.exports.activate(context);
  await controller.refresh();
  t.after(() => context.subscriptions.forEach((entry) => entry.dispose()));
  return { controller, context, api, git, vscode, snapshot, decorations, stored, viewEvents, treeEvents, commands, repositoryEvents };
}

async function folderFixture(t, options) {
  const result = await fixture(t, options);
  result.git.getSnapshot = async (root, target) => ({
    ...result.snapshot(root, target),
    files: [{ path: 'src/deep/file.txt', oldPath: 'src/deep/file.txt', status: 'M' }]
  });
  result.git.getTrackedFiles = async () => ['src/deep/file.txt', 'quiet/untouched.txt'];
  await result.controller.refresh();
  return result;
}

test('target selection invalidates old refresh before workspace storage completes', async (t) => {
  const { controller, context, git, vscode, snapshot } = await fixture(t);
  const oldResult = deferred();
  const oldStarted = deferred();
  const stored = deferred();
  const newStarted = deferred();
  git.getSnapshot = async (root, target) => {
    if (target === 'refs/heads/main') {
      oldStarted.resolve();
      return oldResult.promise;
    }
    newStarted.resolve();
    return snapshot(root, target);
  };
  const oldRefresh = controller.refresh();
  await oldStarted.promise;
  context.workspaceState.update = () => stored.promise;
  vscode.window.showQuickPick = async () => ({ ref: 'refs/heads/other' });
  const selected = controller.selectTarget();
  await newStarted.promise;
  oldResult.resolve(snapshot('/first/repo', 'refs/heads/main'));
  await oldRefresh;
  assert.equal(controller.targetRef, 'refs/heads/other');
  stored.resolve();
  await selected;
  assert.equal(controller.snapshot.targetRef, 'refs/heads/other');
});

test('old tree elements keep their own snapshot after repository switching', async (t) => {
  const { controller, api } = await fixture(t);
  const oldNode = controller.getChildren()[0];
  const oldSnapshot = controller.snapshot;
  controller.setRepository(api.repositories[1]);
  await controller.refresh();
  const oldItem = controller.getTreeItem(oldNode);
  assert.equal(oldItem.command.arguments[1], oldSnapshot);
  assert.equal(oldItem.command.arguments[1].root, '/first/repo');
  assert.equal(controller.snapshot.root, '/second/repo');
});

test('repository removed while its picker is open cannot be reselected', async (t) => {
  const { controller, api, vscode } = await fixture(t);
  const picker = deferred();
  const closed = api.repositories[0];
  vscode.window.showQuickPick = () => picker.promise;
  const selecting = controller.selectRepository();
  api.repositories.shift();
  controller.syncRepository();
  picker.resolve({ repository: closed });
  await selecting;
  assert.equal(controller.repository, api.repositories[0]);
  await controller.refresh();
  assert.equal(controller.snapshot.root, '/second/repo');
});

test('tree items use theme-aware file and folder icons with isolated resource URIs', async (t) => {
  const { controller } = await fixture(t);
  const node = controller.getChildren()[0];
  const item = controller.getTreeItem({ ...node, path: 'src/file #?% ü.ts', label: 'file #?% ü.ts' });
  assert.equal(item.iconPath.id, 'file');
  assert.equal(item.resourceUri.path, '/src/file #?% ü.ts');
  assert.equal(item.resourceUri.scheme, 'branch-changes-tree');
  assert.equal(item.resourceUri.query, 'M');
  assert.equal(item.description, undefined, 'Status badge should not be duplicated as description');
  assert.equal(item.command.arguments[1], node.snapshot);

  const folder = controller.getTreeItem({ kind: 'folder', path: 'src', label: 'src', changed: true });
  assert.equal(folder.iconPath.id, 'folder');
  assert.equal(folder.resourceUri.path, '/src');
  assert.equal(folder.resourceUri.query, '');
  assert.equal(folder.collapsibleState, 2);
});

test('branch status badges use Git theme colors without affecting working-tree files or diffs', async (t) => {
  const { decorations } = await fixture(t);
  const expected = {
    A: ['Added', 'added'], M: ['Modified', 'modified'], D: ['Deleted', 'deleted'],
    R: ['Renamed', 'renamed'], C: ['Copied', 'added'], T: ['Type changed', 'modified']
  };
  for (const [status, [name, color]] of Object.entries(expected)) {
    const decoration = decorations.provideFileDecoration({ scheme: 'branch-changes-tree', query: status });
    assert.equal(decoration.badge, status);
    assert.equal(decoration.tooltip, name);
    assert.equal(decoration.color.id, `gitDecoration.${color}ResourceForeground`);
    assert.equal(decoration.propagate, false);
  }
  for (const uri of [
    { scheme: 'file', query: 'M' },
    { scheme: 'branch-changes', query: 'M' },
    { scheme: 'branch-changes-tree', query: '' },
    { scheme: 'branch-changes-tree', query: 'unknown' },
    { scheme: 'branch-changes-tree', query: 'constructor' }
  ]) {
    assert.equal(decorations.provideFileDecoration(uri), undefined);
  }
});

test('all-files mode is the default and unchanged files and folders are dim without badges', async (t) => {
  const { controller, decorations, git } = await fixture(t);
  assert.equal(controller.showAllFiles, true);
  git.getTrackedFiles = async () => ['file.txt', 'quiet/untouched.txt'];
  await controller.refresh();
  const folder = controller.getChildren().find((node) => node.kind === 'folder');
  const folderItem = controller.getTreeItem(folder);
  const fileItem = controller.getTreeItem(folder.children[0]);
  assert.equal(folderItem.collapsibleState, 1, 'Unchanged folders start collapsed');
  assert.equal(folderItem.resourceUri.query, 'unchanged');
  assert.equal(fileItem.resourceUri.query, 'unchanged');
  assert.equal(fileItem.command.command, 'branchChanges.openFile');
  assert.match(fileItem.tooltip, /^Unchanged:/);
  for (const item of [folderItem, fileItem]) {
    const decoration = decorations.provideFileDecoration(item.resourceUri);
    assert.equal(decoration.color.id, 'descriptionForeground');
    assert.equal(decoration.badge, undefined);
    assert.equal(decoration.propagate, false);
  }
  assert.match(controller.view.message, /^1 committed change · files, respecting Git ignores/);
});

test('view mode persists false and stays selected across repository switches', async (t) => {
  const { controller, stored, api, git } = await fixture(t);
  await controller.setShowAllFiles(false);
  assert.equal(stored.get('branchChanges.showAllFiles'), false);
  assert.equal(controller.getChildren().length, 1);
  git.getTrackedFiles = () => assert.fail('Changes-only mode must not enumerate all files');
  controller.setRepository(api.repositories[1]);
  await controller.refresh();
  assert.equal(controller.showAllFiles, false);
  assert.equal(controller.getChildren().length, 1);

  const reloaded = await fixture(t, { showAllFiles: false });
  assert.equal(reloaded.controller.showAllFiles, false);
  assert.equal(reloaded.controller.getChildren().length, 1);
});

test('a stale full-tree enumeration cannot overwrite a newer changes-only refresh', async (t) => {
  const { controller, git } = await fixture(t);
  const pending = deferred();
  const started = deferred();
  git.getTrackedFiles = async () => {
    started.resolve();
    return pending.promise;
  };
  const oldRefresh = controller.refresh();
  await started.promise;
  await controller.setShowAllFiles(false);
  pending.resolve(['file.txt', 'stale/untouched.txt']);
  await oldRefresh;
  assert.equal(controller.showAllFiles, false);
  assert.equal(controller.getChildren().length, 1);
  assert.match(controller.view.message, /changes only/);
});

test('zero net changes still shows dim files in all-files mode and an empty changes-only tree', async (t) => {
  const { controller, git, snapshot } = await fixture(t);
  git.getSnapshot = async (root, target) => ({ ...snapshot(root, target), files: [] });
  await controller.refresh();
  assert.equal(controller.getChildren().length, 2);
  assert.ok(controller.getChildren().every((node) => !node.changed));
  assert.match(controller.view.message, /^0 committed changes/);
  await controller.setShowAllFiles(false);
  assert.equal(controller.getChildren().length, 0);
  assert.match(controller.view.message, /No net changes/);
});

test('old unchanged nodes open only their own immutable HEAD after repository switching', async (t) => {
  const { controller, api, vscode } = await fixture(t);
  const node = controller.getChildren().find((item) => !item.changed);
  const item = controller.getTreeItem(node);
  controller.setRepository(api.repositories[1]);
  await controller.refresh();
  let opened;
  let shown;
  vscode.workspace.openTextDocument = async (uri) => { opened = uri; return { uri }; };
  vscode.window.showTextDocument = async (document) => { shown = document; };
  await controller.openFile(...item.command.arguments);
  const revision = JSON.parse(opened.query);
  assert.equal(revision.root, '/first/repo');
  assert.equal(revision.commit, node.snapshot.head);
  assert.equal(revision.filePath, 'untouched.txt');
  assert.equal(shown.uri, opened);
});

test('a newly affected folder changes decoration identity without highlighting untouched siblings', async (t) => {
  const { controller, git, snapshot, decorations } = await fixture(t);
  git.getTrackedFiles = async () => ['quiet/untouched.txt', 'quiet/edited.txt'];
  git.getSnapshot = async (root, target) => ({ ...snapshot(root, target), files: [] });
  await controller.refresh();
  const before = controller.getTreeItem(controller.getChildren()[0]);
  assert.equal(before.resourceUri.query, 'unchanged');

  git.getSnapshot = async (root, target) => ({
    ...snapshot(root, target), files: [{ path: 'quiet/edited.txt', oldPath: 'quiet/edited.txt', status: 'M' }]
  });
  await controller.refresh();
  const folder = controller.getChildren()[0];
  const after = controller.getTreeItem(folder);
  assert.equal(after.resourceUri.path, before.resourceUri.path);
  assert.notEqual(after.resourceUri.query, before.resourceUri.query);
  assert.equal(decorations.provideFileDecoration(after.resourceUri), undefined);
  const sibling = controller.getTreeItem(folder.children.find((node) => !node.changed));
  assert.equal(decorations.provideFileDecoration(sibling.resourceUri).color.id, 'descriptionForeground');
});

test('refresh publishes atomically and honors folder interaction while loading', async (t) => {
  const { controller, git, viewEvents, treeEvents, snapshot } = await folderFixture(t);
  const oldChildren = controller.children;
  const oldSnapshot = controller.snapshot;
  const eventCount = treeEvents.length;
  const pending = deferred();
  git.getSnapshot = () => pending.promise;
  const loading = controller.refresh();
  assert.equal(controller.children, oldChildren);
  assert.equal(controller.snapshot, oldSnapshot);
  assert.equal(treeEvents.length, eventCount, 'Must not emit an empty intermediate tree');
  viewEvents.collapse({ element: oldChildren.find((node) => node.path === 'src') });
  pending.resolve({ ...snapshot('/first/repo', 'refs/heads/main'), files: oldSnapshot.files });
  await loading;
  assert.equal(controller.getTreeItem(controller.children.find((node) => node.path === 'src')).collapsibleState, 1);
  assert.equal(treeEvents.length, eventCount + 1);
});

test('explicit folder choices survive filters, changed status, deletion and reload', async (t) => {
  const { controller, git, viewEvents, stored, snapshot } = await folderFixture(t);
  let src = controller.children.find((node) => node.path === 'src');
  const quiet = controller.children.find((node) => node.path === 'quiet');
  viewEvents.collapse({ element: src });
  viewEvents.collapse({ element: src.children[0] });
  viewEvents.expand({ element: quiet });
  await controller.setShowAllFiles(false);
  assert.ok(!controller.children.some((node) => node.path === 'quiet'));
  await controller.setShowAllFiles(true);
  src = controller.children.find((node) => node.path === 'src');
  assert.equal(controller.getTreeItem(src).collapsibleState, 1);
  assert.equal(controller.getTreeItem(src.children[0]).collapsibleState, 1);
  assert.equal(controller.getTreeItem(controller.children.find((node) => node.path === 'quiet')).collapsibleState, 2);

  git.getSnapshot = async (root, target) => ({ ...snapshot(root, target), files: [] });
  git.getTrackedFiles = async () => ['quiet/untouched.txt'];
  await controller.refresh();
  git.getTrackedFiles = async () => ['src/deep/file.txt', 'quiet/untouched.txt'];
  await controller.refresh();
  assert.equal(controller.getTreeItem(controller.children.find((node) => node.path === 'src')).collapsibleState, 1);
  const reloaded = await folderFixture(t, { stored: [...stored] });
  assert.equal(reloaded.controller.getTreeItem(reloaded.controller.children.find((node) => node.path === 'src')).collapsibleState, 1);
  assert.equal(reloaded.controller.getTreeItem(reloaded.controller.children.find((node) => node.path === 'quiet')).collapsibleState, 2);
});

test('folder states and tree identities are repository-scoped and reject late events', async (t) => {
  const { controller, api, viewEvents } = await folderFixture(t);
  const oldNode = controller.children.find((node) => node.path === 'src');
  const oldId = controller.getTreeItem(oldNode).id;
  viewEvents.collapse({ element: oldNode });
  await controller.refresh();
  viewEvents.expand({ element: oldNode }); // Late event from the replaced publication.
  assert.equal(controller.getTreeItem(controller.children.find((node) => node.path === 'src')).collapsibleState, 1);
  controller.setRepository(api.repositories[1]);
  await controller.refresh();
  const other = controller.children.find((node) => node.path === 'src');
  assert.notEqual(controller.getTreeItem(other).id, oldId);
  assert.equal(controller.getTreeItem(other).collapsibleState, 2);
  viewEvents.expand({ element: oldNode }); // Late event from another repository.
  controller.setRepository(api.repositories[0]);
  await controller.refresh();
  assert.equal(controller.getTreeItem(controller.children.find((node) => node.path === 'src')).collapsibleState, 1);
});

test('new folders use defaults without reopening a collapsed existing parent', async (t) => {
  const { controller, git, viewEvents, snapshot } = await folderFixture(t);
  viewEvents.collapse({ element: controller.children.find((node) => node.path === 'src') });
  git.getSnapshot = async (root, target) => ({
    ...snapshot(root, target), files: [{ path: 'src/new/file.txt', oldPath: 'src/new/file.txt', status: 'A' }]
  });
  git.getTrackedFiles = async () => ['src/new/file.txt', 'new-quiet/untouched.txt'];
  await controller.refresh();
  const src = controller.children.find((node) => node.path === 'src');
  assert.equal(controller.getTreeItem(src).collapsibleState, 1);
  assert.equal(controller.getTreeItem(src.children[0]).collapsibleState, 2);
  assert.equal(controller.getTreeItem(controller.children.find((node) => node.path === 'new-quiet')).collapsibleState, 1);
});

test('failed comparisons retain the published tree with an explicit stale-view message', async (t) => {
  const { controller, git, treeEvents } = await folderFixture(t);
  const previous = controller.children;
  const events = treeEvents.length;
  git.getSnapshot = async () => { throw new Error('comparison unavailable'); };
  await controller.refresh();
  assert.equal(controller.children, previous);
  assert.equal(treeEvents.length, events);
  assert.match(controller.view.message, /comparison unavailable.*last successful view/);
});

test('automatic refresh never opens, replaces or closes editor documents', async (t) => {
  const { controller, git, repositoryEvents, commands, vscode } = await folderFixture(t);
  const started = deferred();
  const next = git.getSnapshot;
  git.getSnapshot = async (...args) => { started.resolve(); return next(...args); };
  vscode.workspace.openTextDocument = () => assert.fail('Refresh must not open documents');
  vscode.window.showTextDocument = () => assert.fail('Refresh must not replace editors');
  commands.length = 0;
  const before = controller.publication;
  repositoryEvents.get('/first/repo')();
  await started.promise;
  await controller.refresh();
  assert.ok(controller.publication > before);
  assert.equal(commands.length, 0, 'Refresh must not run editor/diff/close commands');
});

test('local context is distinct and ignore toggles never override committed paths or deletion diffs', async (t) => {
  const { controller, git, snapshot, stored, decorations } = await fixture(t);
  const local = (filePath, ignored = false) => ({ path: filePath, oldPath: filePath, status: '', local: true, ignored });
  git.getSnapshot = async (root, target) => ({
    ...snapshot(root, target), files: [{ path: 'deleted.txt', oldPath: 'deleted.txt', status: 'D' }]
  });
  git.getTrackedFiles = async () => ['tracked.txt'];
  git.getLocalFiles = async (_root, ignored) => [
    local('tracked.txt'), local('deleted.txt'), local('local/new.txt'), ...(ignored ? [local('cache/generated.txt', true)] : [])
  ];
  await controller.refresh();
  assert.equal(controller.showIgnoredFiles, false);
  assert.ok(!controller.children.some((node) => node.path === 'cache'));
  assert.equal(controller.children.find((node) => node.path === 'tracked.txt').local, undefined);
  assert.equal(controller.children.find((node) => node.path === 'deleted.txt').status, 'D');
  const newFile = controller.children.find((node) => node.path === 'local').children[0];
  const item = controller.getTreeItem(newFile);
  assert.equal(item.command.command, 'branchChanges.openFile');
  assert.match(item.tooltip, /Local file \(not in committed diff\)/);
  assert.equal(item.resourceUri.query, 'local');
  assert.equal(newFile.changed, false);
  await controller.setShowIgnoredFiles(true);
  assert.equal(stored.get('branchChanges.showIgnoredFiles'), true);
  const ignoredFolder = controller.children.find((node) => node.path === 'cache');
  assert.equal(ignoredFolder.changed, false);
  assert.equal(controller.getTreeItem(ignoredFolder).resourceUri.query, 'ignored');
  const ignoredItem = controller.getTreeItem(ignoredFolder.children[0]);
  assert.equal(decorations.provideFileDecoration(ignoredItem.resourceUri).color.id, 'gitDecoration.ignoredResourceForeground');
  assert.match(ignoredItem.tooltip, /Ignored local file/);
  assert.match(controller.view.message, /^1 committed change/);
  await controller.setShowIgnoredFiles(false);
  assert.ok(!controller.children.some((node) => node.path === 'cache'));
});

test('local files open their working-tree URI, while local enumeration errors preserve committed context', async (t) => {
  const { controller, git, vscode } = await fixture(t);
  let opened;
  vscode.workspace.openTextDocument = async (uri) => { opened = uri; return { uri }; };
  vscode.window.showTextDocument = async () => {};
  await controller.openFile({ path: 'local/new #?%.txt', local: true }, controller.snapshot);
  assert.equal(opened.scheme, 'file');
  assert.equal(opened.path, '/first/repo/local/new #?%.txt');
  git.getLocalFiles = async () => { throw new Error('local output limit'); };
  await controller.refresh();
  assert.equal(controller.children.length, 2);
  assert.match(controller.view.message, /Local files could not be loaded: local output limit/);
});
