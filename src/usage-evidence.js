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
const { findFiles } = require("./project");

const EVIDENCE = {
  PACKAGE_SCRIPT: "PACKAGE_SCRIPT",
  CLI_COMMAND: "CLI_COMMAND",
};

// Split a shell-like string into command clauses (across &&, ||, ;, |,
// and newlines) and return just the "word" naming the command actually
// being invoked in each clause - not its arguments or flags.
function commandNamesIn(text) {
  const names = [];
  const clauses = String(text).split(/&&|\|\||[;|\n]/);

  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    // Drop Make's silent/ignore-error/always-run prefixes (@ - +) and
    // any leading path ("./node_modules/.bin/vite" -> "vite")
    const firstToken = tokens[0].replace(/^[@\-+]+/, "").split("/").pop();
    if (firstToken) {
      names.push(firstToken);
    }

    // "python -m X" / "python3 -m X" - the launched module is the real
    // command, the interpreter is just how it's started
    if (/^python3?$/.test(firstToken) && tokens[1] === "-m" && tokens[2]) {
      names.push(tokens[2].split("/").pop());
    }
  }

  return names;
}

// RUN/CMD/ENTRYPOINT lines - both shell form ("RUN pip install ...")
// and JSON exec form (CMD ["uvicorn", "main:app"]), where the first
// array element is the real command.
function extractDockerfileCommands(content) {
  const commands = [];

  for (const rawLine of content.split("\n")) {
    const match = rawLine.trim().match(/^(?:RUN|CMD|ENTRYPOINT)\s+(.+)$/i);
    if (!match) {
      continue;
    }
    const body = match[1].trim();

    const arrayMatch = body.match(/^\[(.*)\]$/);
    if (arrayMatch) {
      const first = arrayMatch[1].match(/"([^"]*)"|'([^']*)'/);
      const name = first ? (first[1] || first[2] || "").split("/").pop() : "";
      if (name) {
        commands.push(name);
      }
      continue;
    }

    commands.push(...commandNamesIn(body));
  }

  return commands;
}

// Makefile recipe lines are tab-indented, under a "target:" line
function extractMakefileCommands(content) {
  const commands = [];
  for (const rawLine of content.split("\n")) {
    if (rawLine.startsWith("\t")) {
      commands.push(...commandNamesIn(rawLine.trim()));
    }
  }
  return commands;
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

// Scan a workspace for usage evidence beyond source imports: package
// manager scripts and real CLI invocations in Makefiles, shell
// scripts, Dockerfiles, docker-compose files, CI workflows, and
// README code fences. Returns `{ [dependency]: [{type, file, detail}] }`.
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
        recordEvidence(evidence, dependencies, commandNamesIn(script), EVIDENCE.PACKAGE_SCRIPT, packageJsonPath);
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

    const names = commandNamesForFile(path.basename(filePath), content);
    if (names.length > 0) {
      recordEvidence(evidence, dependencies, names, EVIDENCE.CLI_COMMAND, filePath);
    }
  }

  return evidence;
}

module.exports = { collectNonImportEvidence, EVIDENCE };
