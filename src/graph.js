// Import graph + reachability (Part 8).
//
// Figures out which local files are actually reachable from the app's
// entry point. If no entry point can be found, never guess — just treat
// everything as reachable, same as before this file existed.

const fs = require("fs");
const path = require("path");

const RESOLVABLE_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"];

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch (error) {
    return false;
  }
}

// Resolve a local import to a real file
function resolveLocalImport(fromFile, specifier) {
  if (!specifier || !(specifier.startsWith("./") || specifier.startsWith("../"))) {
    return null;
  }

  const targetPath = path.resolve(path.dirname(fromFile), specifier);
  const explicitExt = path.extname(specifier);

  if (explicitExt) {
    // Already has an extension, e.g. "./Header.jsx"
    // Skip non-source files like .css or .svg
    return RESOLVABLE_EXTENSIONS.includes(explicitExt) && isFile(targetPath) ? targetPath : null;
  }

  // Try common extensions
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const withExt = targetPath + ext;
    if (isFile(withExt)) {
      return withExt;
    }
  }

  // Try as a folder with an index file
  for (const ext of RESOLVABLE_EXTENSIONS) {
    const indexFile = path.join(targetPath, "index" + ext);
    if (isFile(indexFile)) {
      return indexFile;
    }
  }

  return null;
}

// Common entry point filenames
const ENTRY_POINT_CANDIDATES = [
  "src/main.js", "src/main.jsx", "src/main.mjs", "src/main.ts", "src/main.tsx",
  "src/index.js", "src/index.jsx", "src/index.mjs", "src/index.ts", "src/index.tsx",
  // Backend-style entry names too (e.g. server/src/server.js)
  "src/server.js", "src/server.ts",
  "src/app.js", "src/app.ts",
  "main.js", "main.jsx",
  "index.js", "index.jsx",
  "server.js", "server.ts",
  "app.js", "app.ts",
];

// Find application entry points
function findEntryPoints(root, scannedFiles, packageJson) {
  const scanned = new Set(scannedFiles);
  const entryPoints = new Set();

  for (const candidate of ENTRY_POINT_CANDIDATES) {
    const absolute = path.join(root, candidate);
    if (scanned.has(absolute)) {
      entryPoints.add(absolute);
    }
  }

  // Also check package.json's "main" field
  const mainField = packageJson && typeof packageJson.main === "string" ? packageJson.main : null;
  if (mainField) {
    const specifier = mainField.startsWith(".") ? mainField : `./${mainField}`;
    const resolved = resolveLocalImport(path.join(root, "package.json"), specifier);
    if (resolved && scanned.has(resolved)) {
      entryPoints.add(resolved);
    }
  }

  return [...entryPoints];
}

// Trace reachable source files
function analyzeReachability({ root, scannedFiles, localImportsByFile, packageJson }) {
  const entryPoints = findEntryPoints(root, scannedFiles, packageJson);

  if (entryPoints.length === 0) {
    // No entry point found — don't guess, treat everything as reachable
    return { confident: false, entryPoints: [], reachableFiles: new Set(scannedFiles) };
  }

  // Walk the import graph from each entry point
  const reachable = new Set();
  const queue = [...entryPoints];

  while (queue.length > 0) {
    const current = queue.shift();
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);

    const specifiers = localImportsByFile[current] || [];
    for (const specifier of specifiers) {
      const resolved = resolveLocalImport(current, specifier);
      if (resolved && !reachable.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return { confident: true, entryPoints, reachableFiles: reachable };
}

module.exports = { analyzeReachability, resolveLocalImport, findEntryPoints };
