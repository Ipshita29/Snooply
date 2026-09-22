// Non-import usage evidence: a dependency can be genuinely used
// without ever appearing in a source-file import - invoked as a CLI
// command (uvicorn, pytest, eslint, vite...), or declared in a
// package-manager script. "No import found" alone must never be read
// as "unused" - this module gathers the other real signals so the
// recommendation engine can tell the difference between "truly no
// evidence" and "just not imported directly".
//
// Only structured, executable-shaped content is scanned: package.json
// scripts, Makefiles, shell scripts, Dockerfiles, docker-compose
// files, CI workflow files, and (only inside fenced code blocks, never
// prose) README files. A README sentence like "you can install
// uvicorn" is never evidence; a Makefile line that actually runs
// `uvicorn ...` is. Only the command position of each clause counts -
// an argument that happens to share a dependency's name is not usage.

const fs = require("fs");
const path = require("path");
const { findFiles, isPathExcluded } = require("./project");

const EVIDENCE = {
  PACKAGE_SCRIPT: "PACKAGE_SCRIPT",
  CLI_COMMAND: "CLI_COMMAND",
};

// A followed wrapper script chain never goes deeper than this, and a
// followed file is never bigger than this - both purely as a safety
// backstop (on top of the visited-path cycle guard below), since a
// real wrapper script is always small and shallow.
const MAX_FOLLOW_DEPTH = 5;
const MAX_FOLLOWED_SCRIPT_BYTES = 65536;

// Turn one raw command token into a matchable entry: `name` is the
// existing exact-match candidate (path-stripped, so
// "./node_modules/.bin/vite" -> "vite" still matches the dependency
// name directly, same as before); `reference` is set only when the
// token is an explicit relative path ("./scripts/dev.sh",
// "scripts/dev.sh") - never a bare name (resolved via $PATH, could be
// any installed program) and never an absolute path - so only an
// unambiguous local project script is ever eligible to be followed.
function toCommandEntry(rawToken) {
  const cleaned = String(rawToken).replace(/^[@\-+]+/, "");
  const name = cleaned.split("/").pop();
  if (!name) {
    return null;
  }
  const reference = cleaned.includes("/") && !cleaned.startsWith("/") ? cleaned : undefined;
  return { name, reference };
}

// Split a shell-like string into command clauses (across &&, ||, ;, |,
// and newlines) and return an entry for the command actually being
// invoked in each clause - not its arguments or flags.
function commandNamesIn(text) {
  const entries = [];
  const clauses = String(text).split(/&&|\|\||[;|\n]/);

  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    const entry = toCommandEntry(tokens[0]);
    if (entry) {
      entries.push(entry);
    }

    // "python -m X" / "python3 -m X" - the launched module is the real
    // command, the interpreter is just how it's started
    if (entry && /^python3?$/.test(entry.name) && tokens[1] === "-m" && tokens[2]) {
      const moduleEntry = toCommandEntry(tokens[2]);
      if (moduleEntry) {
        entries.push(moduleEntry);
      }
    }
  }

  return entries;
}

// Follow a local script reference to its real file (if any) and
// extract further command entries from it too - recursively, so a
// wrapper of a wrapper still resolves. Only ever follows the explicit
// relative-path references toCommandEntry() produces (never a bare
// command name or an absolute path), and only inside this project:
// `isPathExcluded` applies the exact same safety list, .gitignore, and
// nested-repo-boundary rules the main source walk does. `visited`
// (shared across one whole follow chain) stops a circular reference
// (A calls B, B calls A) from looping forever, on top of the fixed
// depth cap.
function followReferences(entries, { root, callerDir, visited, depth }) {
  const found = [];
  if (depth > MAX_FOLLOW_DEPTH) {
    return found;
  }

  for (const entry of entries) {
    if (!entry.reference) {
      continue;
    }

    const resolved = path.resolve(callerDir, entry.reference);

    if (visited.has(resolved) || isPathExcluded(root, resolved)) {
      continue;
    }

    let stats;
    try {
      stats = fs.statSync(resolved);
    } catch (error) {
      continue; // missing script - nothing to follow, not an error
    }
    if (!stats.isFile() || stats.size > MAX_FOLLOWED_SCRIPT_BYTES) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(resolved, "utf-8");
    } catch (error) {
      continue;
    }

    visited.add(resolved);

    const nestedEntries = commandNamesIn(content);
    for (const nested of nestedEntries) {
      found.push({ name: nested.name, file: resolved });
    }
    found.push(...followReferences(nestedEntries, { root, callerDir: path.dirname(resolved), visited, depth: depth + 1 }));
  }

  return found;
}

// RUN/CMD/ENTRYPOINT lines - both shell form ("RUN pip install ...")
// and JSON exec form (CMD ["uvicorn", "main:app"]), where the first
// array element is the real command.
function extractDockerfileCommands(content) {
  const entries = [];

  for (const rawLine of content.split("\n")) {
    const match = rawLine.trim().match(/^(?:RUN|CMD|ENTRYPOINT)\s+(.+)$/i);
    if (!match) {
      continue;
    }
    const body = match[1].trim();

    const arrayMatch = body.match(/^\[(.*)\]$/);
    if (arrayMatch) {
      const first = arrayMatch[1].match(/"([^"]*)"|'([^']*)'/);
      const entry = first ? toCommandEntry(first[1] || first[2] || "") : null;
      if (entry) {
        entries.push(entry);
      }
      continue;
    }

    entries.push(...commandNamesIn(body));
  }

  return entries;
}

// Makefile recipe lines are tab-indented, under a "target:" line
function extractMakefileCommands(content) {
  const entries = [];
  for (const rawLine of content.split("\n")) {
    if (rawLine.startsWith("\t")) {
      entries.push(...commandNamesIn(rawLine.trim()));
    }
  }
  return entries;
}

// YAML "key: value" (docker-compose "command:", CI "run:"), including
// the block-scalar form (key: | / key: >) where the value is the
// following more-indented lines rather than the inline text.
function extractYamlValues(content, keys) {
  const values = [];
  const lines = content.split("\n");
  // Leading whitespace, plus an optional YAML list-item "- " marker,
  // since a step's "run:"/"command:" is usually itself a list entry
  const keyPattern = new RegExp(`^(\\s*(?:-\\s+)?)(?:${keys.join("|")})\\s*:\\s*(.*)$`);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(keyPattern);
    if (!match) {
      continue;
    }
    const [, indent, inline] = match;
    const trimmedInline = inline.trim();

    if (trimmedInline === "" || /^[|>][+-]?\d*$/.test(trimmedInline)) {
      const baseIndent = indent.length;
      let j = i + 1;
      while (j < lines.length) {
        if (lines[j].trim() === "") {
          j++;
          continue;
        }
        const lineIndent = lines[j].match(/^(\s*)/)[1].length;
        if (lineIndent <= baseIndent) {
          break;
        }
        values.push(lines[j].trim());
        j++;
      }
      continue;
    }

    values.push(trimmedInline.replace(/^["']|["']$/g, ""));
  }

  return values;
}

// Only fenced code blocks (```...```) - prose around them is never
// scanned, so a sentence mentioning a package name is never evidence.
function extractFencedCodeBlocks(content) {
  const blocks = [];
  const pattern = /```[^\n]*\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(content))) {
    blocks.push(match[1]);
  }
  return blocks;
}

function isWorkflowFile(fullPath) {
  return fullPath.split(path.sep).join("/").includes("/.github/workflows/");
}

function isEvidenceFileName(name, fullPath) {
  if (/^dockerfile(\.|$)/i.test(name)) return true;
  if (/^(makefile|gnumakefile)$/i.test(name)) return true;
  if (name.endsWith(".sh")) return true;
  if (/^(docker-compose|compose)\.ya?ml$/i.test(name)) return true;
  if ((name.endsWith(".yml") || name.endsWith(".yaml")) && isWorkflowFile(fullPath)) return true;
  if (/^readme(\.md)?$/i.test(name)) return true;
  return false;
}

function commandNamesForFile(name, content) {
  if (/^dockerfile(\.|$)/i.test(name)) {
    return extractDockerfileCommands(content);
  }
  if (/^(makefile|gnumakefile)$/i.test(name)) {
    return extractMakefileCommands(content);
  }
  if (name.endsWith(".sh")) {
    return commandNamesIn(content);
  }
  if (/^(docker-compose|compose)\.ya?ml$/i.test(name)) {
    return extractYamlValues(content, ["command"]).flatMap(commandNamesIn);
  }
  if (name.endsWith(".yml") || name.endsWith(".yaml")) {
    return extractYamlValues(content, ["run"]).flatMap(commandNamesIn);
  }
  if (/^readme(\.md)?$/i.test(name)) {
    return extractFencedCodeBlocks(content).flatMap(commandNamesIn);
  }
  return [];
}

function recordEvidence(evidence, dependencies, names, type, file) {
  for (const name of names) {
    if (dependencies.has(name)) {
      if (!evidence[name]) {
        evidence[name] = [];
      }
      evidence[name].push({ type, file, detail: name });
    }
  }
}

// Follow every local-script reference among `entries` (found in
// `sourceFile`) and record whatever command names those scripts
// themselves invoke - recursively - as CLI_COMMAND evidence. Always
// CLI_COMMAND regardless of how the chain was reached (a package
// script or a Makefile line): by the time a name is found this way, a
// real script file was actually read and it genuinely is a command.
function recordFollowedEvidence(evidence, dependencies, entries, root, sourceFile) {
  const followed = followReferences(entries, {
    root,
    callerDir: path.dirname(sourceFile),
    visited: new Set([sourceFile]),
    depth: 1,
  });

  for (const { name, file } of followed) {
    recordEvidence(evidence, dependencies, [name], EVIDENCE.CLI_COMMAND, file);
  }
}

// Scan a workspace for usage evidence beyond source imports: package
// manager scripts and real CLI invocations in Makefiles, shell
// scripts, Dockerfiles, docker-compose files, CI workflows, and
// README code fences - following a local wrapper script a command
// refers to ("./scripts/dev.sh") so a dependency invoked only inside
// it is still recognized. Returns
// `{ [dependency]: [{type, file, detail}] }`.
function collectNonImportEvidence(root, dependencies, excludedDirs = new Set()) {
  const evidence = {};
  if (!dependencies || dependencies.size === 0) {
    return evidence;
  }

  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      for (const script of Object.values(packageJson.scripts || {})) {
        const entries = commandNamesIn(script);
        recordEvidence(evidence, dependencies, entries.map((e) => e.name), EVIDENCE.PACKAGE_SCRIPT, packageJsonPath);
        recordFollowedEvidence(evidence, dependencies, entries, root, packageJsonPath);
      }
    } catch (error) {
      // Malformed package.json is reported elsewhere - nothing to add here
    }
  }

  const candidateFiles = findFiles(root, isEvidenceFileName, excludedDirs);

  for (const filePath of candidateFiles) {
    let content;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      continue;
    }

    const entries = commandNamesForFile(path.basename(filePath), content);
    if (entries.length > 0) {
      recordEvidence(evidence, dependencies, entries.map((e) => e.name), EVIDENCE.CLI_COMMAND, filePath);
    }
    recordFollowedEvidence(evidence, dependencies, entries, root, filePath);
  }

  return evidence;
}

module.exports = { collectNonImportEvidence, EVIDENCE };
