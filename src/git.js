const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function git(root, args, encoding = 'utf8') {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      encoding,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    });
    return stdout;
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(detail, { cause: error });
  }
}

async function getBranches(root) {
  const output = await git(root, [
    'for-each-ref', '--format=%(refname)%09%(symref)', 'refs/heads/', 'refs/remotes/'
  ]);
  return output.split('\n').filter(Boolean).flatMap((line) => {
    const [ref, symbolicTarget] = line.split('\t');
    // origin/HEAD is only an alias, not a separate target branch.
    if (symbolicTarget) return [];
    return [{
      ref,
      label: ref.replace(/^refs\/(heads|remotes)\//, ''),
      remote: ref.startsWith('refs/remotes/')
    }];
  });
}

async function getDefaultTarget(root, branches) {
  let remoteHead;
  try {
    remoteHead = (await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
  } catch {
    // A local-only repository need not have origin/HEAD.
  }
  const current = (await git(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  const candidates = [remoteHead, 'refs/remotes/origin/main', 'refs/heads/main',
    'refs/remotes/origin/master', 'refs/heads/master'];
  // Don't silently compare an unfamiliar branch or a branch with itself.
  return candidates.find((ref) => ref && ref !== current && branches.some((branch) => branch.ref === ref));
}

function parseNameStatus(output) {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const files = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const firstPath = tokens[index++];
    const renamed = status.startsWith('R') || status.startsWith('C');
    const filePath = renamed ? tokens[index++] : firstPath;
    if (!status || !firstPath || !filePath) {
      throw new Error('Invalid file list returned by Git.');
    }
    files.push({
      status: status[0],
      path: filePath,
      oldPath: renamed ? firstPath : filePath
    });
  }
  return files;
}

async function getSnapshot(root, targetRef) {
  // Resolve both ends once. Open diffs keep these exact commits even if HEAD moves.
  const headRef = (await git(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  const head = (await git(root, ['rev-parse', '--verify', `${headRef || 'HEAD'}^{commit}`])).trim();
  const target = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${targetRef}^{commit}`])).trim();
  let bases;
  try {
    bases = (await git(root, ['merge-base', '--all', target, head])).trim().split('\n');
  } catch (error) {
    if (error.cause?.code === 1) {
      throw new Error('No common ancestor found. Choose a related target branch and ensure its history is available locally.');
    }
    throw error;
  }
  if (bases.length !== 1) {
    throw new Error('Multiple common ancestors found. This ambiguous merge history is not supported.');
  }
  const base = bases[0];
  const output = await git(root, [
    'diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z',
    '--find-renames', '--ignore-submodules=none', base, head, '--'
  ]);
  const currentRef = (await git(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  const currentHead = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (currentRef !== headRef || currentHead !== head) {
    throw new Error('The current branch changed during comparison. Refresh to compare its new state.');
  }
  const branch = headRef.replace(/^refs\/heads\//, '') || head.slice(0, 8);
  return { root, head, base, target, targetRef, branch, files: parseNameStatus(output) };
}

async function getFileEntry(root, commit, filePath) {
  // ls-tree also handles submodules and literal paths with Git pathspec characters.
  const entry = await git(root, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', filePath]);
  const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t/.exec(entry);
  if (!match) throw new Error(`Cannot read ${filePath} at ${commit.slice(0, 8)}.`);
  return { mode: match[1], type: match[2], object: match[3] };
}

async function getTrackedFiles(root, commit) {
  const output = await git(root, ['ls-tree', '-r', '--name-only', '-z', commit, '--']);
  return output.split('\0').filter(Boolean);
}

async function getLocalFiles(root, includeIgnored = false) {
  const paths = new Map();
  const deleted = new Set((await git(root, ['ls-files', '--deleted', '-z', '--'])).split('\0'));
  const add = (output, ignored) => {
    for (const filePath of output.split('\0').filter(Boolean)) {
      // Embedded repositories are boundaries, never expose Git metadata.
      if (deleted.has(filePath) || filePath.endsWith('/') || /(^|\/)\.git(\/|$)/i.test(filePath)) continue;
      paths.set(filePath, { path: filePath, oldPath: filePath, status: '', local: true, ignored });
    }
  };
  // Index entries include staged additions not present in the committed tree.
  const index = await git(root, ['ls-files', '--cached', '--stage', '-z', '--']);
  for (const entry of index.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t');
    if (separator < 0) throw new Error('Invalid index entry returned by Git.');
    // Gitlinks point to repositories/directories, not openable local files.
    if (entry.startsWith('160000 ')) continue;
    add(`${entry.slice(separator + 1)}\0`, false);
  }
  add(await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--']), false);
  if (includeIgnored) {
    add(await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--']), true);
  }
  return [...paths.values()];
}

async function readFile(root, commit, filePath) {
  const entry = await getFileEntry(root, commit, filePath);
  if (entry.type === 'commit') return `Subproject commit ${entry.object}\n`;
  const buffer = await git(root, ['cat-file', 'blob', entry.object], 'buffer');
  if (buffer.includes(0)) {
    throw new Error(`Binary file: ${filePath}. This version supports text diffs only.`);
  }
  return buffer.toString('utf8');
}

module.exports = { getBranches, getDefaultTarget, getSnapshot, parseNameStatus, getFileEntry, getTrackedFiles, getLocalFiles, readFile };
