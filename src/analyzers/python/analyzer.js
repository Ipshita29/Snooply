// Python analyzer.
//
// Finds .py source files and reports which declared dependencies they
// actually import. There's no lightweight Python parser available in
// this Node/CommonJS CLI, so this reads imports line by line with a
// couple of regexes instead - reliable enough for real import
// statements without pulling in parsing infrastructure.

const fs = require("fs");
const { findSourceFiles } = require("../../core/project");

const EXTENSIONS = [".py"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Curated import-name -> distribution-name mapping, for the handful of
// well-known cases where they differ. Kept small on purpose - a wrong
// guess (false positive) is worse than missing an obscure package.
const IMPORT_TO_DISTRIBUTION = {
  bs4: "beautifulsoup4",
  PIL: "Pillow",
  sklearn: "scikit-learn",
  cv2: "opencv-python",
  yaml: "PyYAML",
};

// A practical (not exhaustive) list of Python standard-library
// top-level modules. These are never treated as external dependencies.
const PYTHON_STDLIB = new Set([
  "__future__", "abc", "argparse", "array", "ast", "asyncio", "atexit",
  "base64", "bisect", "builtins", "bz2", "calendar", "cmath", "codecs",
  "collections", "compileall", "configparser", "contextlib", "contextvars",
  "copy", "copyreg", "cProfile", "csv", "ctypes", "dataclasses", "datetime",
  "dbm", "decimal", "difflib", "dis", "distutils", "doctest", "email",
  "encodings", "ensurepip", "enum", "errno", "faulthandler", "fcntl",
  "filecmp", "fileinput", "fnmatch", "fractions", "ftplib", "functools",
  "gc", "getopt", "getpass", "gettext", "glob", "graphlib", "grp", "gzip",
  "hashlib", "heapq", "hmac", "html", "http", "imaplib", "importlib",
  "inspect", "io", "ipaddress", "itertools", "json", "keyword", "linecache",
  "locale", "logging", "lzma", "mailbox", "marshal", "math", "mimetypes",
  "mmap", "multiprocessing", "numbers", "operator", "os", "pathlib", "pdb",
  "pickle", "pickletools", "pkgutil", "platform", "poplib", "pprint",
  "profile", "pstats", "pty", "pwd", "py_compile", "pydoc", "queue",
  "quopri", "random", "re", "sched", "secrets", "select", "selectors",
  "shelve", "shlex", "shutil", "signal", "site", "smtplib", "socket",
  "socketserver", "sqlite3", "ssl", "stat", "statistics", "string",
  "stringprep", "struct", "subprocess", "sys", "sysconfig", "syslog",
  "tarfile", "tempfile", "termios", "textwrap", "threading", "time",
  "timeit", "tkinter", "token", "tokenize", "tomllib", "traceback",
  "tracemalloc", "tty", "turtle", "types", "typing", "unicodedata",
  "unittest", "urllib", "uuid", "venv", "warnings", "wave", "weakref",
  "webbrowser", "wsgiref", "xml", "xmlrpc", "zipapp", "zipfile",
  "zipimport", "zlib", "zoneinfo",
]);

// PyPI names are case-insensitive; "-", "_", "." are interchangeable
function normalizeName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

// Match an imported module back to a declared dependency
// (handles distribution/import-name mismatches and PyPI's loose casing)
function resolveTrackedPackage(moduleName, dependencyLookup) {
  const top = moduleName.split(".")[0];
  if (!top || PYTHON_STDLIB.has(top)) {
    return null;
  }

  const candidate = IMPORT_TO_DISTRIBUTION[top] || top;
  return dependencyLookup.get(normalizeName(candidate)) || null;
}

// Record what was imported from a `from x import ...` line
function addImportedNames(usageSet, importedNames) {
  const cleaned = importedNames.replace(/[()\\]/g, "");
  for (const part of cleaned.split(",")) {
    const name = part.trim().split(/\s+as\s+/)[0].trim();
    if (name === "*") {
      usageSet.add("*");
    } else if (name) {
      usageSet.add(name);
    }
  }
}

// Parse one Python file and find package usage
function analyzeFile(code, dependencyLookup, usage) {
  for (const rawLine of code.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    // from x.y import a, b as c
    const fromMatch = line.match(/^from\s+(\.+)?([\w.]*)\s+import\s+(.+)$/);
    if (fromMatch) {
      const [, leadingDots, modulePath, importedNames] = fromMatch;
      if (leadingDots) {
        continue; // relative import - local module, not a dependency
      }

      const pkg = resolveTrackedPackage(modulePath, dependencyLookup);
      if (pkg) {
        addImportedNames(usage[pkg], importedNames);
      }
      continue;
    }

    // import x, y as z
    const importMatch = line.match(/^import\s+(.+)$/);
    if (importMatch) {
      for (const part of importMatch[1].split(",")) {
        const moduleName = part.trim().split(/\s+as\s+/)[0].trim();
        const pkg = resolveTrackedPackage(moduleName, dependencyLookup);
        if (pkg) {
          usage[pkg].add("default");
        }
      }
    }
  }
}

// Scan a workspace's Python files and collect dependency usage
async function analyze(root, dependencies, excludedDirs = new Set()) {
  const files = findSourceFiles(root, EXTENSIONS, excludedDirs);
  const usage = {};
  const usageByFile = {};
  const skippedFiles = [];

  // Look up a declared dependency by its normalized name
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

  return { language: "python", sourceFiles: files, usage, usageByFile, skippedFiles };
}

// This analyzer applies if the workspace has any .py files
function canAnalyze(root, extensionsPresent) {
  return EXTENSIONS.some((ext) => extensionsPresent.has(ext));
}

module.exports = { name: "python", extensions: EXTENSIONS, canAnalyze, analyze };
