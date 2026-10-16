const vscode = require('vscode');
const path = require('node:path');
const { getBranches, getDefaultTarget, getSnapshot, getFileEntry, getTrackedFiles, getLocalFiles, readFile } = require('./git');
const { buildTree } = require('./tree');
const { scheme, revisionUri, readRevision } = require('./documents');

const statusNames = { '': 'Unchanged', A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };
const statusColors = {
  A: 'gitDecoration.addedResourceForeground',
  M: 'gitDecoration.modifiedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
  T: 'gitDecoration.modifiedResourceForeground'
};
const treeScheme = 'branch-changes-tree';

class BranchChanges {
  constructor(context, api) {
    this.context = context;
    this.api = api;
    this.children = [];
    this.generation = 0;
    this.publication = 0;
    this.folderStates = new Map();
    this.showAllFiles = context.workspaceState.get('branchChanges.showAllFiles', true);
    this.showIgnoredFiles = context.workspaceState.get('branchChanges.showIgnoredFiles', false);
    void vscode.commands.executeCommand('setContext', 'branchChanges.showAllFiles', this.showAllFiles);
    void vscode.commands.executeCommand('setContext', 'branchChanges.showIgnoredFiles', this.showIgnoredFiles);
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.view = vscode.window.createTreeView('branchChanges.files', { treeDataProvider: this });
    context.subscriptions.push(this, this.changed, this.view);
    context.subscriptions.push(
      this.view.onDidExpandElement(({ element }) => this.rememberFolderState(element, true)),
      this.view.onDidCollapseElement(({ element }) => this.rememberFolderState(element, false)),
      api.onDidOpenRepository(() => this.syncRepository()),
      api.onDidCloseRepository(() => this.syncRepository())
    );
  }

  dispose() {
    this.generation++;
    clearTimeout(this.timer);
    this.repositoryListener?.dispose();
  }

  getChildren(element) {
    return element ? element.children || [] : this.children;
  }

  getTreeItem(node) {
    const folder = node.kind === 'folder';
    const expanded = folder && (this.getFolderStates(node.repositoryRoot).get(node.path) ?? node.changed);
    const item = new vscode.TreeItem(node.label,
      folder ? (expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
        : vscode.TreeItemCollapsibleState.None);
    item.id = JSON.stringify([node.repositoryRoot, folder ? 'folder' : 'file', node.path]);
    // Keep the real filename for icon themes, but isolate branch decorations
    // from the working-tree decorations of the built-in Git extension.
    let decoration = node.changed ? (folder ? '' : node.status) : 'unchanged';
    const local = folder ? node.localOnly : node.local;
    if (local && !node.changed) decoration = (folder ? node.ignoredOnly : node.ignored) ? 'ignored' : 'local';
    item.resourceUri = vscode.Uri.from({ scheme: treeScheme, path: `/${node.path}`, query: decoration });
    item.iconPath = folder ? new vscode.ThemeIcon('folder') : new vscode.ThemeIcon('file');
    if (local) item.description = decoration === 'ignored' ? 'ignored · local' : 'local';
    if (!folder) {
      const status = local ? (node.ignored ? 'Ignored local file (not in committed diff)' : 'Local file (not in committed diff)')
        : statusNames[node.status] || node.status;
      item.tooltip = `${status}: ${node.path}` +
        (node.oldPath !== node.path ? `\nPreviously: ${node.oldPath}` : '');
      item.command = {
        command: node.changed ? 'branchChanges.openDiff' : 'branchChanges.openFile',
        title: node.changed ? 'Open Diff' : local ? 'Open Local File' : 'Open Committed File', arguments: [node, node.snapshot]
      };
    }
    return item;
  }

  getFolderStates(root) {
    if (!this.folderStates.has(root)) {
      this.folderStates.set(root, new Map(this.context.workspaceState.get(`branchChanges.folders:${root}`, [])));
    }
    return this.folderStates.get(root);
  }

  rememberFolderState(node, expanded) {
    if (node.kind !== 'folder' || node.publication !== this.publication ||
        node.repositoryRoot !== this.repository?.rootUri.fsPath) return;
    const states = this.getFolderStates(node.repositoryRoot);
    states.set(node.path, expanded);
    void this.context.workspaceState.update(`branchChanges.folders:${node.repositoryRoot}`, [...states]).then(undefined, (error) => {
      void vscode.window.showWarningMessage(`Branch Changes: Could not save folder state: ${error.message}`);
    });
  }

  syncRepository() {
    if (!this.repository || !this.api.repositories.includes(this.repository)) {
      this.setRepository(this.api.repositories[0]);
    }
  }

  setRepository(repository) {
    this.repositoryListener?.dispose();
    clearTimeout(this.timer);
    if (repository?.rootUri.fsPath !== this.repository?.rootUri.fsPath) this.clearTree();
    this.repository = repository;
    this.targetRef = repository ? this.context.workspaceState.get(this.targetKey()) : undefined;
    if (repository) {
      this.repositoryListener = repository.state.onDidChange(() => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(), 200);
      });
    }
    void vscode.commands.executeCommand('setContext', 'branchChanges.hasRepository', !!repository);
    void this.refresh();
  }

  clearTree() {
    this.children = [];
    this.snapshot = undefined;
    this.publication = 0;
    this.changed.fire();
  }

  targetKey() {
    return `branchChanges.target:${this.repository.rootUri.fsPath}`;
  }

  async selectRepository() {
    const choices = this.api.repositories.map((repository) => ({
      label: path.basename(repository.rootUri.fsPath),
      description: repository.rootUri.fsPath, repository
    }));
    if (!choices.length) {
      void vscode.window.showInformationMessage('Open a folder containing a Git repository first.');
      return;
    }
    const choice = await vscode.window.showQuickPick(choices, { title: 'Branch Changes: Select Repository' });
    if (choice && this.api.repositories.includes(choice.repository)) this.setRepository(choice.repository);
  }

  async selectTarget() {
    if (!this.repository) return this.selectRepository();
    const repository = this.repository;
    try {
      const branches = await getBranches(repository.rootUri.fsPath);
      const choice = await vscode.window.showQuickPick(branches.map((branch) => ({
        label: branch.label,
        description: `${branch.remote ? 'Remote' : 'Local'}${branch.ref === this.targetRef ? ' · selected' : ''}`,
        ref: branch.ref
      })), { title: 'Compare current branch against…', placeHolder: 'Select the target branch (for example origin/main)' });
      if (!choice || this.repository !== repository || !this.api.repositories.includes(repository)) return;
      this.targetRef = choice.ref;
      // Invalidate old comparisons before awaiting storage, which can be slow.
      const refreshed = this.refresh();
      await this.context.workspaceState.update(this.targetKey(), choice.ref);
      await refreshed;
    } catch (error) {
      void vscode.window.showErrorMessage(`Branch Changes: ${error.message}`);
    }
  }

  async refresh() {
    const generation = ++this.generation;
    const showAllFiles = this.showAllFiles;
    const showIgnoredFiles = this.showIgnoredFiles;
    if (!this.repository) {
      this.clearTree();
      this.view.description = undefined;
      this.view.message = undefined;
      return;
    }
    const root = this.repository.rootUri.fsPath;
    this.view.message = 'Loading committed branch changes…';
    try {
      const branches = await getBranches(root);
      let target = this.targetRef;
      if (!target) target = await getDefaultTarget(root, branches);
      if (generation !== this.generation) return;
      if (!target || !branches.some((branch) => branch.ref === target)) {
        this.clearTree();
        this.view.description = path.basename(root);
        this.view.message = 'Select a target branch using the Compare button above. The repository needs at least one commit.';
        return;
      }
      const snapshot = await getSnapshot(root, target);
      if (generation !== this.generation) return;
      const tracked = showAllFiles ? await getTrackedFiles(root, snapshot.head) : [];
      if (generation !== this.generation) return;
      let local = [];
      let localWarning = '';
      try {
        if (showAllFiles) local = await getLocalFiles(root, showIgnoredFiles);
      } catch (error) {
        localWarning = ` · Local files could not be loaded: ${error.message}`;
      }
      if (generation !== this.generation) return;
      this.targetRef = target;
      this.snapshot = snapshot;
      this.publication = generation;
      this.children = buildTree(
        snapshot.files.map((file) => ({ ...file, snapshot })),
        [
          ...local.map((file) => ({ ...file, snapshot })),
          ...tracked.map((filePath) => ({ path: filePath, oldPath: filePath, status: '', snapshot }))
        ],
        { repositoryRoot: root, publication: generation }
      );
      const targetLabel = branches.find((branch) => branch.ref === target).label;
      this.view.description = `${snapshot.branch} → ${targetLabel}`;
      this.view.message = snapshot.files.length || showAllFiles
        ? `${snapshot.files.length} committed change${snapshot.files.length === 1 ? '' : 's'} · ${showAllFiles ? (showIgnoredFiles ? 'all files, including ignored' : 'files, respecting Git ignores') : 'changes only'}`
        : 'No net changes since the common ancestor. Uncommitted changes are not included.';
      this.view.message += localWarning;
      this.changed.fire();
    } catch (error) {
      if (generation !== this.generation) return;
      this.view.description = path.basename(root);
      this.view.message = `Cannot compare branches: ${error.message}${this.snapshot ? ' Showing the last successful view.' : ''}`;
    }
  }

  async setShowAllFiles(showAllFiles) {
    this.showAllFiles = showAllFiles;
    void vscode.commands.executeCommand('setContext', 'branchChanges.showAllFiles', showAllFiles);
    const refreshed = this.refresh();
    await this.context.workspaceState.update('branchChanges.showAllFiles', this.showAllFiles);
    await refreshed;
  }

  async setShowIgnoredFiles(showIgnoredFiles) {
    this.showIgnoredFiles = showIgnoredFiles;
    void vscode.commands.executeCommand('setContext', 'branchChanges.showIgnoredFiles', showIgnoredFiles);
    const refreshed = this.refresh();
    await this.context.workspaceState.update('branchChanges.showIgnoredFiles', showIgnoredFiles);
    await refreshed;
  }

  async openFile(file, snapshot) {
    if (!file || !snapshot) return;
    const uri = file.local ? vscode.Uri.joinPath(vscode.Uri.file(snapshot.root), file.path)
      : revisionUri(vscode, snapshot.root, snapshot.head, file.path);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      void vscode.window.showErrorMessage(`Branch Changes: ${error.message}`);
    }
  }

  async openDiff(file, snapshot) {
    if (!file || !snapshot) return;
    const before = revisionUri(vscode, snapshot.root, file.status === 'A' ? null : snapshot.base, file.oldPath);
    const after = revisionUri(vscode, snapshot.root, file.status === 'D' ? null : snapshot.head, file.path);
    try {
      // Load both sides first, so unsupported/binary files get a clear error.
      const documents = await Promise.all([
        vscode.workspace.openTextDocument(before), vscode.workspace.openTextDocument(after)
      ]);
      if (file.status !== 'A' && file.status !== 'D' && documents[0].getText() === documents[1].getText()) {
        const [left, right] = await Promise.all([
          getFileEntry(snapshot.root, snapshot.base, file.oldPath),
          getFileEntry(snapshot.root, snapshot.head, file.path)
        ]);
        if (left.mode !== right.mode) {
          void vscode.window.showInformationMessage(`Branch Changes: ${file.path} — file mode changed: ${left.mode} → ${right.mode}. No text changes.`);
        }
      }
      const name = file.oldPath === file.path ? file.path : `${file.oldPath} → ${file.path}`;
      await vscode.commands.executeCommand('vscode.diff', before, after,
        `${name} (${snapshot.base.slice(0, 8)} ↔ ${snapshot.head.slice(0, 8)})`, { preview: true });
    } catch (error) {
      void vscode.window.showErrorMessage(`Branch Changes: ${error.message}`);
    }
  }
}

async function activate(context) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  const git = await gitExtension.activate();
  if (!git.enabled) {
    void vscode.window.showWarningMessage('Branch Changes requires the built-in Git extension to be enabled.');
    return;
  }
  const controller = new BranchChanges(context, git.getAPI(1));
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider({
      provideFileDecoration(uri) {
        if (uri.scheme !== treeScheme) return;
        if (['unchanged', 'local', 'ignored'].includes(uri.query)) {
          const tooltip = { unchanged: 'Unchanged in branch', local: 'Local only — not in committed diff', ignored: 'Ignored local file — not in committed diff' };
          return {
            tooltip: tooltip[uri.query],
            color: new vscode.ThemeColor(uri.query === 'ignored' ? 'gitDecoration.ignoredResourceForeground' : 'descriptionForeground'),
            propagate: false
          };
        }
        if (!Object.hasOwn(statusColors, uri.query)) return;
        return {
          badge: uri.query,
          tooltip: statusNames[uri.query],
          color: new vscode.ThemeColor(statusColors[uri.query]),
          propagate: false
        };
      }
    }),
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent: (uri) => readRevision(uri, readFile)
    }),
    vscode.commands.registerCommand('branchChanges.refresh', () => controller.refresh()),
    vscode.commands.registerCommand('branchChanges.selectTarget', () => controller.selectTarget()),
    vscode.commands.registerCommand('branchChanges.selectRepository', () => controller.selectRepository()),
    vscode.commands.registerCommand('branchChanges.showAllFiles', () => controller.setShowAllFiles(true)),
    vscode.commands.registerCommand('branchChanges.showChangesOnly', () => controller.setShowAllFiles(false)),
    vscode.commands.registerCommand('branchChanges.showIgnoredFiles', () => controller.setShowIgnoredFiles(true)),
    vscode.commands.registerCommand('branchChanges.hideIgnoredFiles', () => controller.setShowIgnoredFiles(false)),
    vscode.commands.registerCommand('branchChanges.openFile', (file, snapshot) => controller.openFile(file, snapshot)),
    vscode.commands.registerCommand('branchChanges.openDiff', (file, snapshot) => controller.openDiff(file, snapshot))
  );
  controller.syncRepository();
}

module.exports = { activate };
