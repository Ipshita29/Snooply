// Java analyzer.
//
// Finds .java source files and reports which declared Maven/Gradle
// dependencies they actually import. There's no lightweight Java
// parser available in this Node/CommonJS CLI, so this reads import
// statements line by line instead - reliable for real import syntax.
// Comments and string literals (including text blocks) are stripped
// first, so "import"-shaped text inside them is never mistaken for a
// real import.

const fs = require("fs");
const { findSourceFiles } = require("../project");
const { stripCodeNoise } = require("./helpers");

const EXTENSIONS = [".java"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Curated artifact-id -> Java package namespace mapping, for the
// common cases where a Maven/Gradle coordinate doesn't match its
// import path. Kept small on purpose - a wrong guess (false positive)
// is worse than missing an obscure library.
const ARTIFACT_TO_NAMESPACE = {
  gson: "com.google.gson",
  "junit-jupiter": "org.junit.jupiter",
  "spring-boot-starter-web": "org.springframework",
  "spring-context": "org.springframework",
};

function splitCoordinate(coordinate) {
  const [groupId, artifactId] = coordinate.split(":");
  return { groupId, artifactId };
}

// Is `importPath` the given namespace, or something inside it?
function isWithinNamespace(importPath, namespace) {
  return importPath === namespace || importPath.startsWith(namespace + ".");
}

// Match an imported namespace back to every declared dependency it
// could plausibly belong to. Tries the curated mapping first, then
// falls back to the dependency's own groupId - which is often (not
// always) the real import prefix, so a fallback-only match is flagged
// as less certain than a curated one.
//
// More than one dependency can legitimately share a namespace (e.g.
// spring-boot-starter-web and spring-context both live under
// org.springframework) - when that happens, credit all of them rather
// than guessing which one "owns" the import. A false "used" here is
// safer than a false "unused" for a dependency that's actually in use.
function resolveTrackedPackages(importPath, dependencyCoordinates) {
  const matches = [];

  for (const coordinate of dependencyCoordinates) {
    const { groupId, artifactId } = splitCoordinate(coordinate);

    const curated = ARTIFACT_TO_NAMESPACE[artifactId];
    if (curated && isWithinNamespace(importPath, curated)) {
      matches.push({ coordinate, viaFallback: false });
      continue;
    }

    if (groupId && isWithinNamespace(importPath, groupId)) {
      matches.push({ coordinate, viaFallback: true });
    }
  }

  return matches;
}

// Parse one Java file and find package usage. `curatedDependencies`/
// `fallbackDependencies` accumulate across the whole workspace, so the
// caller can tell afterward which dependencies were ever confirmed by
// a curated mapping versus only ever reached through the fallback.
function analyzeFile(code, dependencyCoordinates, usage, curatedDependencies, fallbackDependencies) {
  const stripped = stripCodeNoise(code, { nestedBlockComments: false });
  const lines = stripped.split("\n");

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line.startsWith("import")) {
      continue;
    }

    // An import can (rarely) be split across lines with no delimiter
    // other than the missing terminator - keep pulling lines in until
    // we see the ";". Joining with a space and stripping whitespace
    // from the matched path afterward handles the break landing
    // anywhere, without needing to guess where a real space belongs.
    while (!line.includes(";") && i + 1 < lines.length) {
      i++;
      line += " " + lines[i].trim();
    }

    const match = line.match(/^import\s+(static\s+)?([\w.\s*]+?)\s*;/);
    if (!match) {
      continue;
    }

    let importPath = match[2].replace(/\s+/g, "");
    const isWildcard = importPath.endsWith(".*");
    if (isWildcard) {
      importPath = importPath.slice(0, -2);
    }

    if (importPath.startsWith("java.") || importPath.startsWith("javax.")) {
      continue; // standard library - never an external dependency
    }

    const matches = resolveTrackedPackages(importPath, dependencyCoordinates);
    const evidence = isWildcard ? "*" : importPath.split(".").pop();

    for (const { coordinate, viaFallback } of matches) {
      usage[coordinate].add(evidence);
      (viaFallback ? fallbackDependencies : curatedDependencies).add(coordinate);
    }
  }
}

// Scan a workspace's Java files and collect dependency usage
async function analyze(root, dependencies, excludedDirs = new Set()) {
  const files = findSourceFiles(root, EXTENSIONS, excludedDirs);
  const usage = {};
  const usageByFile = {};
  const skippedFiles = [];
  const dependencyCoordinates = [...dependencies];
  const curatedDependencies = new Set();
  const fallbackDependencies = new Set();

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
      analyzeFile(code, dependencyCoordinates, fileUsage, curatedDependencies, fallbackDependencies);
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

  // A dependency reached only through the groupId fallback (never
  // confirmed by the curated mapping) gets a "medium" confidence hint
  const matchConfidence = {};
  for (const coordinate of fallbackDependencies) {
    if (!curatedDependencies.has(coordinate)) {
      matchConfidence[coordinate] = "medium";
    }
  }

  return { language: "java", sourceFiles: files, usage, usageByFile, skippedFiles, matchConfidence };
}

// This analyzer applies if the workspace has any .java files
function canAnalyze(root, extensionsPresent) {
  return EXTENSIONS.some((ext) => extensionsPresent.has(ext));
}

module.exports = { name: "java", extensions: EXTENSIONS, canAnalyze, analyze };
