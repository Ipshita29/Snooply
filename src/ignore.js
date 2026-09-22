// Project ignore rules: .gitignore pattern matching, and detection of
// nested repository boundaries (a subdirectory that is itself a
// separate git repo - e.g. a runtime-cloned copy of another project).
//
// This is deliberately a compact, practical subset of real gitignore
// semantics - not a byte-for-byte reimplementation of git's own
// matching engine. It supports the patterns real .gitignore files
// actually use (comments, negation, directory-only patterns, "/"
// anchoring, "*", "**", "?") without pulling in a parsing dependency.

const fs = require("fs");
const path = require("path");

function escapeRegexLiteral(char) {
  return char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

// Convert one gitignore glob body (no leading "!", no leading/trailing
// "/") into the equivalent regex source, matching "/"-joined paths.
function globToRegexSource(pattern) {
  let out = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        let j = i + 2;
        if (pattern[j] === "/") {
          j++;
        }
        out += "(?:.*/)?";
        i = j;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }

    out += escapeRegexLiteral(ch);
    i++;
  }

  return out;
}

// Parse one non-blank, non-comment .gitignore line into a matchable rule
function parseGitignoreLine(rawLine) {
  let line = rawLine.replace(/\r$/, "");
  if (!line.trim() || line.trim().startsWith("#")) {
    return null;
  }
  line = line.replace(/\s+$/, "");
  if (!line) {
    return null;
  }

  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  }

  let dirOnly = false;
  if (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (!line) {
    return null;
  }

  let anchored = line.startsWith("/");
  if (anchored) {
    line = line.slice(1);
  }
  if (line.includes("/")) {
    // A pattern with an interior slash is always anchored to the
    // .gitignore's own directory, even without a leading "/"
    anchored = true;
  }

  const body = globToRegexSource(line);
  const source = anchored ? `^${body}$` : `(?:^|/)${body}$`;

  return { negate, dirOnly, regex: new RegExp(source) };
}

// Read and parse the .gitignore in one directory, if any. Returns []
// (not an error) when there isn't one - most directories won't have one.
function loadGitignoreRules(directory) {
  let content;
  try {
    content = fs.readFileSync(path.join(directory, ".gitignore"), "utf-8");
  } catch (error) {
    return [];
  }

  const rules = [];
  for (const line of content.split("\n")) {
    const rule = parseGitignoreLine(line);
    if (rule) {
      rules.push(rule);
    }
  }
  return rules;
}

// Does the accumulated stack of .gitignore rules (root-to-leaf order,
// each with the directory it was found in) say `fullPath` is ignored?
// Later rules win over earlier ones - including a nested .gitignore
// overriding a broader rule from an ancestor, and a later line in the
// same file overriding an earlier one - the same as real git.
//
// This function only decides one path at a time; it's the caller
// (walkFiles/findWorkspaceRoots) that gives this real git semantics
// for "a negated pattern cannot resurrect a file whose parent
// directory is excluded": once a directory itself matches an ignore
// rule, the caller never recurses into it at all, so nothing under it
// - including a nested .gitignore's own negations - is ever consulted.
// That mirrors git's own traversal (it doesn't walk into an ignored
// directory to look for re-inclusion rules either), so the trade-off
// once noted here doesn't actually apply - see test/ignore.test.js for
// the exact "build/ + !build/important.js" case this guarantees.
function isIgnoredByGitignore(ruleStack, fullPath, isDirectory) {
  let ignored = false;

  for (const { baseDir, rules } of ruleStack) {
    const relPath = path.relative(baseDir, fullPath).split(path.sep).join("/");
    if (!relPath || relPath.startsWith("..")) {
      continue;
    }

    for (const rule of rules) {
      if (rule.dirOnly && !isDirectory) {
        continue;
      }
      if (rule.regex.test(relPath)) {
        ignored = !rule.negate;
      }
    }
  }

  return ignored;
}

// Is `directory` itself the root of a separate git repository? (a
// directory, not a file, since a git worktree/submodule can leave a
// ".git" *file* instead of a folder - either means "separate repo").
function isNestedRepoBoundary(directory) {
  try {
    fs.statSync(path.join(directory, ".git"));
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = { loadGitignoreRules, isIgnoredByGitignore, isNestedRepoBoundary };
