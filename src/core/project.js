// Project/workspace scanning. Language-agnostic - analyzers tell it
// which file extensions they care about, this just walks directories.

const fs = require("fs");
const path = require("path");
const { manifestFileNames } = require("./package-managers");

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

// Walk a directory tree, calling `visit(fullPath, name)` for every
// regular file found. Shared by anything that needs to look at every
// file once - which extensions to filter by is up to the caller.
// (excludedDirs skips other workspaces nested inside this one)
function walkFiles(directory, excludedDirs, visit) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    return;
  }

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

    if (stats.isDirectory()) {
      walkFiles(fullPath, excludedDirs, visit);
    } else {
      visit(fullPath, item);
    }
  }
}

// Find files under a directory matching the given extensions
function findSourceFiles(directory, extensions, excludedDirs = new Set()) {
  const files = [];

  walkFiles(directory, excludedDirs, (fullPath, name) => {
    if (extensions.some((ext) => name.endsWith(ext))) {
      files.push(fullPath);
    }
  });

  return files;
}

// Find every file extension present under a directory - used to decide
// which language analyzers are actually worth running, without each
// one having to walk the whole tree itself just to check.
function findExtensionsPresent(directory, excludedDirs = new Set()) {
  const extensions = new Set();

  walkFiles(directory, excludedDirs, (fullPath, name) => {
    const ext = path.extname(name);
    if (ext) {
      extensions.add(ext);
    }
  });

  return extensions;
}

// Find every workspace root - anywhere with a package manifest
// (covers single packages, apps/*, packages/*, or any other layout)
function findWorkspaceRoots(startDir) {
  const manifests = manifestFileNames();
  const roots = [];

  function walk(dir) {
    if (manifests.some((name) => fs.existsSync(path.join(dir, name)))) {
      roots.push(dir);
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      walk(path.join(dir, entry.name));
    }
  }

  walk(startDir);
  return roots;
}

// Short label for a workspace, like "client" or "apps/web"
function getWorkspaceLabel(root, projectPath) {
  const relative = path.relative(projectPath, root);
  return relative === "" ? "root" : relative.split(path.sep).join("/");
}

module.exports = {
  IGNORED_DIRECTORIES,
  findSourceFiles,
  findExtensionsPresent,
  findWorkspaceRoots,
  getWorkspaceLabel,
};
