const scheme = 'branch-changes';

// An empty side still has the original file extension for language detection.
function revisionUri(vscode, root, commit, filePath) {
  return vscode.Uri.from({
    scheme,
    path: `/${filePath}`,
    query: JSON.stringify({ root, commit, filePath })
  });
}

async function readRevision(uri, readFile) {
  const { root, commit, filePath } = JSON.parse(uri.query);
  if (typeof root !== 'string' || typeof filePath !== 'string' ||
      (commit !== null && !/^[a-f0-9]{40,64}$/.test(commit))) {
    throw new Error('Invalid branch comparison document.');
  }
  return commit === null ? '' : readFile(root, commit, filePath);
}

module.exports = { scheme, revisionUri, readRevision };
