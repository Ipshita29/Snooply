// Project/workspace scanning. Language-agnostic - analyzers tell it
// which file extensions they care about, this just walks directories.

const fs = require("fs");
const path = require("path");
const { manifestFileNames } = require("./package-managers");
const { loadGitignoreRules, isIgnoredByGitignore, isNestedRepoBoundary } = require("./ignore");

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  // Python-specific: compiled bytecode and virtual environments -
  // never real application source, and venvs can contain thousands
  // of vendored files that would otherwise swamp the scan
  "__pycache__",
  "venv",
  ".venv",
  // Java-specific: Maven/Gradle build output, never real source
  "target",
  "out",
  ".gradle",
  "bin",
  // Go-specific: vendored copies of dependencies and scratch output -
  // not the project's own source
  "vendor",
  "tmp",
]);

// Walk a directory tree, calling `visit(fullPath, name)` for every
// regular file found. Shared by anything that needs to look at every
// file once - which extensions to filter by is up to the caller.
// (excludedDirs skips other workspaces nested inside this one)
//
// Two things stop a subtree from contributing files beyond the fixed
// IGNORED_DIRECTORIES safety list:
//  - .gitignore rules, accumulated as the walk descends (a nested
//    .gitignore adds more rules for its own subtree, same as git)
//  - a subdirectory that is itself a separate git repository (has its
//    own .git) - e.g. a runtime-cloned copy of another project. That
//    is a different codebase, not this project's own source, so its
//    files must never count as usage evidence here.
function walkFiles(directory, excludedDirs, visit, gitignoreStack = []) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    return;
  }

  const ownRules = loadGitignoreRules(directory);
  const stack = ownRules.length > 0 ? gitignoreStack.concat([{ baseDir: directory, rules: ownRules }]) : gitignoreStack;

  for (const item of entries) {
    if (IGNORED_DIRECTORIES.has(item)) {
      continue;
    }

    const fullPath = path.join(directory, item);

    if (excludedDirs.has(fullPath)) {
      continue;
    }

    let stats;
    try {
      stats = fs.statSync(fullPath);
    } catch (error) {
      continue;
    }

    if (stack.length > 0 && isIgnoredByGitignore(stack, fullPath, stats.isDirectory())) {
      continue;
    }

    if (stats.isDirectory()) {
      if (isNestedRepoBoundary(fullPath)) {
        continue;
      }
      walkFiles(fullPath, excludedDirs, visit, stack);
    } else {
      visit(fullPath, item);
    }
  }
}

// Find files under a directory matching the given extensions
function findSourceFiles(directory, extensions, excludedDirs = new Set()) {
  return findFiles(directory, (name) => extensions.some((ext) => name.endsWith(ext)), excludedDirs);
}

// Find files under a directory whose name satisfies `matches(name,
// fullPath)` - the same walk (and the same .gitignore/nested-repo/
// ignored-directory rules) as findSourceFiles, just not limited to
// language extensions. Used for non-source evidence files: Makefiles,
// shell scripts, etc. (`fullPath` lets a predicate care about location,
// e.g. only matching *.yml under .github/workflows/).
function findFiles(directory, matches, excludedDirs = new Set()) {
  const files = [];

  walkFiles(directory, excludedDirs, (fullPath, name) => {
    if (matches(name, fullPath)) {
      files.push(fullPath);
    }
  });

  return files;
}

// Find every file extension present under a directory - used to decide
// which language analyzers are actually worth running, without each
// one having to walk the whole tree itself just to check.
//
// `.d.ts` is reported as its own thing, not folded into `.ts` - a
// declaration file isn't real TypeScript source, so a workspace with
// only .d.ts files shouldn't be enough to select the TypeScript analyzer.
function findExtensionsPresent(directory, excludedDirs = new Set()) {
  const extensions = new Set();

  walkFiles(directory, excludedDirs, (fullPath, name) => {
    if (name.endsWith(".d.ts")) {
      extensions.add(".d.ts");
      return;
    }

    const ext = path.extname(name);
    if (ext) {
      extensions.add(ext);
    }
  });

  return extensions;
}

// Find every workspace root - anywhere with a package manifest
// (covers single packages, apps/*, packages/*, or any other layout).
// Respects the same .gitignore rules and nested-repo boundaries as
// walkFiles, so a manifest inside an ignored or vendored/cloned
// subtree is never mistaken for one of this project's own workspaces.
function findWorkspaceRoots(startDir) {
  const manifests = manifestFileNames();
  const roots = [];

  function walk(dir, gitignoreStack) {
    if (manifests.some((name) => fs.existsSync(path.join(dir, name)))) {
      roots.push(dir);
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }

    const ownRules = loadGitignoreRules(dir);
    const stack = ownRules.length > 0 ? gitignoreStack.concat([{ baseDir: dir, rules: ownRules }]) : gitignoreStack;

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (stack.length > 0 && isIgnoredByGitignore(stack, fullPath, true)) {
        continue;
      }
      if (isNestedRepoBoundary(fullPath)) {
        continue;
      }

      walk(fullPath, stack);
    }
  }

  walk(startDir, []);
  return roots;
}

// Short label for a workspace, like "client" or "apps/web"
function getWorkspaceLabel(root, projectPath) {
  const relative = path.relative(projectPath, root);
  return relative === "" ? "root" : relative.split(path.sep).join("/");
}

// Is `targetPath` (a single already-known file, not necessarily found
// by walking) excluded by the same rules walkFiles enforces - the
// fixed safety list, .gitignore, and nested-repo boundaries? Used when
// something outside the normal top-down walk needs to check one path
// on its own, e.g. following a script reference to confirm the target
// is actually part of this project's own source before reading it.
function isPathExcluded(root, targetPath) {
  const relative = path.relative(root, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return true;
  }

  const segments = relative.split(path.sep);
  let current = root;
  const gitignoreStack = [];

  const rootRules = loadGitignoreRules(root);
  if (rootRules.length > 0) {
    gitignoreStack.push({ baseDir: root, rules: rootRules });
  }

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (IGNORED_DIRECTORIES.has(segment)) {
      return true;
    }

    current = path.join(current, segment);
    const isLastSegment = i === segments.length - 1;

    if (isIgnoredByGitignore(gitignoreStack, current, !isLastSegment)) {
      return true;
    }

    if (!isLastSegment) {
      if (isNestedRepoBoundary(current)) {
        return true;
      }
      const rules = loadGitignoreRules(current);
      if (rules.length > 0) {
        gitignoreStack.push({ baseDir: current, rules });
      }
    }
  }

  return false;
}

module.exports = {
  IGNORED_DIRECTORIES,
  findSourceFiles,
  findFiles,
  findExtensionsPresent,
  findWorkspaceRoots,
  getWorkspaceLabel,
  isPathExcluded,
};
