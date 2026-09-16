// Rust analyzer.
//
// Finds .rs source files and reports which declared Cargo.toml
// dependencies they actually use. There's no lightweight Rust parser
// available in this Node/CommonJS CLI, so this extracts `use` and
// `extern crate` statements with regexes instead - reliable for real
// import syntax. Comments and string literals are stripped first, so
// "use"-shaped text inside them (including inside a macro's string
// argument) is never mistaken for a real import.

const fs = require("fs");
const { findSourceFiles } = require("../project");
const { stripCodeNoise } = require("./helpers");

const EXTENSIONS = [".rs"];

const RUST_STDLIB = new Set(["std", "core", "alloc"]);
const LOCAL_PREFIXES = new Set(["crate", "self", "super"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cargo package names commonly use hyphens; the crate name Rust code
// actually imports always uses underscores instead (hyphens aren't
// valid in a Rust identifier)
function normalizeName(name) {
  return name.replace(/-/g, "_");
}

// Pull the crate name and (when simple enough) the imported item out
// of a `use` path or `extern crate` path. Aliases (`as x`) never
// change which crate is referenced, only what it's called locally.
function parseUsePath(rawPath) {
  const withoutAlias = rawPath.split(/\s+as\s+/)[0].trim();
  const crateName = withoutAlias.split(/::|\{/)[0].trim();
  const rest = withoutAlias.slice(crateName.length).replace(/^::/, "");
  const item = rest.split(/[,{}]/)[0].trim();
  return { crateName, item };
}

// Record usage for one `use`/`extern crate` path
function recordUsage(rawPath, dependencyLookup, usage) {
  const { crateName, item } = parseUsePath(rawPath);

  if (!crateName || RUST_STDLIB.has(crateName) || LOCAL_PREFIXES.has(crateName)) {
    return; // standard library or a local crate::/self::/super:: reference
  }

  const dependency = dependencyLookup.get(normalizeName(crateName));
  if (!dependency) {
    return;
  }

  usage[dependency].add(item || "default");
}

// Parse one Rust file and find crate usage
function analyzeFile(code, dependencyLookup, usage) {
  const stripped = stripCodeNoise(code, { nestedBlockComments: true });

  const usePattern = /\b(?:pub\s+)?use\s+([^;]+);/g;
  let match;
  while ((match = usePattern.exec(stripped))) {
    recordUsage(match[1], dependencyLookup, usage);
  }

  const externCratePattern = /\bextern\s+crate\s+([^;]+);/g;
  while ((match = externCratePattern.exec(stripped))) {
    recordUsage(match[1], dependencyLookup, usage);
  }
}

// Scan a workspace's Rust files and collect dependency usage
async function analyze(root, dependencies, excludedDirs = new Set()) {
  const files = findSourceFiles(root, EXTENSIONS, excludedDirs);
  const usage = {};
  const usageByFile = {};
  const skippedFiles = [];

  // Look up a declared dependency by its normalized (underscore) name
  const dependencyLookup = new Map();
  for (const dependency of dependencies) {
    usage[dependency] = new Set();
    usageByFile[dependency] = [];
    dependencyLookup.set(normalizeName(dependency), dependency);
  }

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];

    const fileUsage = {};
    for (const dependency of dependencies) {
      fileUsage[dependency] = new Set();
    }

    try {
      const code = fs.readFileSync(filePath, "utf-8");
      analyzeFile(code, dependencyLookup, fileUsage);
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

  return { language: "rust", sourceFiles: files, usage, usageByFile, skippedFiles };
}

// This analyzer applies if the workspace has any .rs files
function canAnalyze(root, extensionsPresent) {
  return EXTENSIONS.some((ext) => extensionsPresent.has(ext));
}

module.exports = { name: "rust", extensions: EXTENSIONS, canAnalyze, analyze };
