const path = require('node:path').posix;

function buildTree(files, allFiles = [], { repositoryRoot, publication } = {}) {
  const root = { children: [], folders: new Map() };
  // HEAD supplies the context; changes override it and also retain deleted paths.
  const entries = new Map(allFiles.map((file) => [file.path, file]));
  for (const file of files) entries.set(file.path, file);
  for (const file of entries.values()) {
    const changed = !!file.status;
    const parts = file.path.split('/');
    let parent = root;
    let folderPath = '';
    for (const part of parts.slice(0, -1)) {
      folderPath = folderPath ? `${folderPath}/${part}` : part;
      if (!parent.folders.has(part)) {
        const folder = {
          kind: 'folder', label: part, path: folderPath, changed: false, localOnly: true, ignoredOnly: true,
          repositoryRoot, publication, children: [], folders: new Map()
        };
        parent.folders.set(part, folder);
        parent.children.push(folder);
      }
      parent = parent.folders.get(part);
      parent.changed ||= changed;
      parent.localOnly &&= !!file.local;
      parent.ignoredOnly &&= !!file.ignored;
    }
    parent.children.push({ kind: 'file', label: path.basename(file.path), ...file, changed, repositoryRoot, publication });
  }
  function sort(node) {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    for (const folder of node.folders.values()) sort(folder);
  }
  sort(root);
  return root.children;
}

module.exports = { buildTree };
