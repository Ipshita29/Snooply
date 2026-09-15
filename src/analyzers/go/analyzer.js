// Go analyzer.
//
// Finds .go source files and reports which declared go.mod
// dependencies they actually import. There's no lightweight Go parser
// available in this Node/CommonJS CLI, so this reads import statements
// line by line instead - reliable for real import syntax, though
// (being regex-based) it can't perfectly tell a comment from a string
// literal in every case. Comments are stripped before scanning to keep
// obvious false positives out.

const fs = require("fs");
const path = require("path");
const { findSourceFiles } = require("../../core/project");

const EXTENSIONS = [".go"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read this workspace's own module path from go.mod, so its own
// internal packages aren't mistaken for an external dependency
function readModulePath(root) {
  try {
    const content = fs.readFileSync(path.join(root, "go.mod"), "utf-8");
    const match = content.match(/^module\s+(\S+)/m);
    return match ? match[1] : null;
  } catch (error) {
    return null;
  }
}

// Strip comments so "// import ..." isn't mistaken for a real import
function stripComments(code) {
  const withoutBlocks = code.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("\n")
    .map((line) => line.split("//")[0])
    .join("\n");
}

// Pull import paths out of both grouped and single-line import
// statements. Aliases, blank imports (_) and dot imports (.) all
// come before the quoted path, so the same pattern covers all of them.
function extractImportPaths(code) {
  const paths = [];

  const blockPattern = /import\s*\(([\s\S]*?)\)/g;
  let blockMatch;
  while ((blockMatch = blockPattern.exec(code))) {
    for (const rawLine of blockMatch[1].split("\n")) {
      const match = rawLine.trim().match(/^(?:[\w.]+\s+)?"([^"]+)"/);
      if (match) {
        paths.push(match[1]);
      }
    }
  }

  // Single-line imports live outside any import(...) block
  const withoutBlocks = code.replace(/import\s*\([\s\S]*?\)/g, "");
  for (const rawLine of withoutBlocks.split("\n")) {
    const match = rawLine.trim().match(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/);
    if (match) {
      paths.push(match[1]);
    }
  }

  return paths;
}

// Go standard-library packages have a plain first segment (fmt, net,
// encoding, ...). Third-party packages start with a domain-like
// segment (github.com, golang.org, ...) which always contains a dot.
function isStandardLibrary(importPath) {
  return !importPath.split("/")[0].includes(".");
}

// A Go module major-version suffix (/v2, /v3, ...) - v1 has none.
// A module path with this suffix is a distinct module identity, not a
// subpackage of the unsuffixed path.
const MAJOR_VERSION_SEGMENT = /^v([2-9]|[1-9][0-9]+)$/;

// Is `importPath` the given path, or a subpackage of it?
// ("github.com/example/foo" must not match "github.com/example/foobar",
// and must not match "github.com/example/foo/v2/..." either - that's
// a different module unless the dependency itself declares that /v2)
function isWithinPath(importPath, prefix) {
  if (importPath === prefix) {
    return true;
  }
  if (!importPath.startsWith(prefix + "/")) {
    return false;
  }

  const nextSegment = importPath.slice(prefix.length + 1).split("/")[0];
  return !MAJOR_VERSION_SEGMENT.test(nextSegment);
}

// Match an imported package back to the declared module that owns it
function resolveTrackedPackage(importPath, dependencyPaths) {
  for (const modulePath of dependencyPaths) {
    if (isWithinPath(importPath, modulePath)) {
      return modulePath;
    }
  }
  return null;
}

// Parse one Go file and find package usage
function analyzeFile(code, dependencyPaths, ownModulePath, usage) {
  const importPaths = extractImportPaths(stripComments(code));

  for (const importPath of importPaths) {
    if (isStandardLibrary(importPath)) {
      continue;
    }
    if (ownModulePath && isWithinPath(importPath, ownModulePath)) {
      continue; // local project package, not a dependency
    }

    const dependency = resolveTrackedPackage(importPath, dependencyPaths);
    if (!dependency) {
      continue;
    }

    const segments = importPath.split("/");
    usage[dependency].add(segments[segments.length - 1]);
  }
}

// Scan a workspace's Go files and collect dependency usage
async function analyze(root, dependencies, excludedDirs = new Set()) {
  const files = findSourceFiles(root, EXTENSIONS, excludedDirs);
  const usage = {};
  const usageByFile = {};
  const skippedFiles = [];
  const dependencyPaths = [...dependencies];
  const ownModulePath = readModulePath(root);

  for (const dependency of dependencies) {
    usage[dependency] = new Set();
    usageByFile[dependency] = [];
  }

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];

    const fileUsage = {};
    for (const dependency of dependencies) {
      fileUsage[dependency] = new Set();
    }

    try {
      const code = fs.readFileSync(filePath, "utf-8");
      analyzeFile(code, dependencyPaths, ownModulePath, fileUsage);
    } catch (error) {
      // File couldn't be read/analyzed - skip it, don't stop the run
      skippedFiles.push(filePath);
      continue;
    }

    for (const dependency of dependencies) {
      for (const evidence of fileUsage[dependency]) {
        usage[dependency].add(evidence);
      }
      if (fileUsage[dependency].size > 0) {
        usageByFile[dependency].push({ file: filePath, used: [...fileUsage[dependency]] });
      }
    }

    // Let the loading animation redraw on big projects
    if (i % 15 === 0) {
      await sleep(0);
    }
  }

  return { language: "go", sourceFiles: files, usage, usageByFile, skippedFiles };
}

// This analyzer applies if the workspace has any .go files
function canAnalyze(root, extensionsPresent) {
  return EXTENSIONS.some((ext) => extensionsPresent.has(ext));
}

module.exports = { name: "go", extensions: EXTENSIONS, canAnalyze, analyze };
