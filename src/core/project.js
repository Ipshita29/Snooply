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

// Find files under a directory matching the given extensions
// (excludedDirs skips other workspaces nested inside this one)
function findSourceFiles(directory, extensions, excludedDirs = new Set()) {
  const files = [];

  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    return files;
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
      files.push(...findSourceFiles(fullPath, extensions, excludedDirs));
    } else if (extensions.some((ext) => item.endsWith(ext))) {
      files.push(fullPath);
    }
  }

  return files;
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
  findWorkspaceRoots,
  getWorkspaceLabel,
};
