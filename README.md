# Branch Changes

A VS Code extension for **the final, combined changes of your entire Git branch** —
like a pull request's file tree, right inside your editor.

If a file changes across multiple commits, it appears only once with the combined
result. Fully reverted changes do not count as changes. No server connection or
sign-in is required.

## Installation

Requirements: VS Code 1.85 or later, Git on your `PATH`, the enabled built-in Git
extension, and a trusted local workspace. You do not need a separate Node.js or
npm installation on the machine where you use the extension.

1. Download the `.vsix` file from the [latest release](https://github.com/windischb/vscode-branch-changes/releases/latest).
   Alternatively, build the package yourself as described below.
2. In VS Code, select **Extensions → … → Install from VSIX…** and open the package.
3. Reload the VS Code window if prompted.

Or install from a terminal:

```sh
code --install-extension branch-changes-0.1.1.vsix
```

Install updates from GitHub releases manually in the same way.

## Usage

1. Open a Git repository and select **Branch Changes** in the Activity Bar.
2. Use **Select Target Branch** to choose the branch to compare against, such as `origin/main`.
3. Click a changed file to open the native, read-only diff editor.

- **Full tree:** Committed files and folders remain visible for context; unchanged
  paths are dimmed. File-type icons follow your active theme, and colored status
  badges identify changes.
- **Show Changes Only / Show All Files:** Switch between net changes and the full tree.
- **Show Ignored Files / Hide Ignored Files:** Include or hide ignored local files
  in the full tree. When hidden, Git's ignore rules apply, including global excludes.
- **Local context:** Additional, uncommitted files are explicitly labeled `local`
  or `ignored · local`. They open the actual local file and never contribute to
  the branch diff or change count.
- **Refresh:** The view refreshes automatically when Git state changes.
  Refresh manually for ignored local files when needed.
- **Select Repository:** Switch repositories when more than one is open.

View options and your folder expansion choices are saved. New folders start
expanded if they contain committed changes, and collapsed otherwise. Your explicit
choices take precedence. Refreshing does not close or replace editor tabs.
Historical content stays bound to its original commit; clicking a file again
opens the current snapshot. Single clicks still use VS Code's normal preview-tab
behavior.

## Comparison and limitations

The comparison is equivalent to `git diff <target-branch>...HEAD`: the common
ancestor of the target and current branch compared with the current commit.

- **Committed changes only:** The staging area and working tree do not affect
  the diff. Committed entries take precedence over local file context.
- Git detects renames. Added, deleted, and renamed files appear alongside all
  other net changes in the same tree.
- Tracked files remain visible even when they match ignore rules. Git metadata
  and local contents of nested repositories or submodules are not traversed.
- Symbolic links display their stored link target; submodules display their
  commit ID. File-mode-only changes are explained when opened.
- Binary files are listed but cannot be opened as text diffs.
  Text content is read as UTF-8.
- The extension does not fetch, check out, merge, or write to your repository.
  Update remote-tracking branches yourself when needed.
- Missing or ambiguous history is reported as an error. If a refresh fails,
  the last successful view remains available.
- Git commands are limited to 15 seconds and 32 MiB of output. Very large ignored
  directories can reach these limits; the committed tree remains available
  without the additional local context in that case.
- Tested on macOS so far; Windows and Linux have not yet been verified.

## Development

Node.js 18 or later and Git are sufficient to run the tests. There are no project
dependencies to install:

```sh
npm run check
npm test
```

To try the extension, open the project folder in VS Code and select **Run → Run
Without Debugging** with the **Run Branch Changes** configuration. Open your
Git repository in the new Extension Development Host window.

With `code` on your `PATH`, `npm run test:vscode` also runs a host test with native
diffs. It opens a temporary test repository with a separate profile, leaving your
existing VS Code settings untouched. Only this isolated test process disables
the Workspace Trust prompt for its generated test fixture.

### Build a VSIX

Use a Node.js version supported by the current `vsce` release and run this command
in the project folder:

```sh
npx @vscode/vsce package --no-dependencies
```

`npx` downloads the packaging tool if necessary. This command does not publish
anything; it creates `branch-changes-0.1.1.vsix`. The package includes only the
runtime files, Activity Bar icon, package manifest, and this README.
For a new release, first increment the version in `package.json`, then attach
the generated VSIX as a release asset.
