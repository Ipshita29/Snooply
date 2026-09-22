// Regression tests for project scope/ignore rules: .gitignore support
// (root and nested), and nested-repository-boundary detection (a
// subdirectory that is itself a separate git repo, e.g. a runtime-
// cloned copy of another project). These must keep ignored/foreign
// code from ever contributing dependency usage evidence or being
// discovered as a separate workspace.
//
// Run with: node test/ignore.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { findSourceFiles, findWorkspaceRoots } = require("../src/project");
const { readManifest } = require("../src/package-managers");
const { analyzeWorkspace } = require("../src/analyze");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL - ${name}`);
    console.log(`  ${error.message}`);
  }
}

function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-ignore-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

function isUsed(usage, dep) {
  return Boolean(usage[dep]) && usage[dep].size > 0;
}

(async () => {
  // ================= .gitignore support =================

  await test("Root .gitignore excludes a matching directory from source scanning", async () => {
    const dir = makeFixture({
      ".gitignore": "cloned_repos/\n",
      "package.json": JSON.stringify({ dependencies: {} }),
      "cloned_repos/app.js": "console.log('should never be scanned');",
      "index.js": "console.log('real source');",
    });
    const files = findSourceFiles(dir, [".js"], new Set());
    assert.deepStrictEqual(
      files.map((f) => path.relative(dir, f)),
      ["index.js"]
    );
  });

  await test("Root .gitignore excludes generated/analysis-style directories", async () => {
    const dir = makeFixture({
      ".gitignore": "analysis/\n",
      "analysis/report.py": "import pandas\n",
      "main.py": "print('hi')\n",
    });
    const files = findSourceFiles(dir, [".py"], new Set());
    assert.deepStrictEqual(
      files.map((f) => path.relative(dir, f)),
      ["main.py"]
    );
  });

  await test(".gitignore wildcard and dotfile patterns work", async () => {
    const dir = makeFixture({
      ".gitignore": "*.log\n.env\n",
      "debug.log": "noise",
      ".env": "SECRET=x",
      "index.js": "console.log('hi');",
    });
    const files = findSourceFiles(dir, [".js", ".log"], new Set());
    assert.deepStrictEqual(
      files.map((f) => path.relative(dir, f)),
      ["index.js"]
    );
  });

  await test("Nested .gitignore adds rules scoped to its own subtree only", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: {} }),
      "frontend/.gitignore": "generated/\n",
      "frontend/generated/output.js": "console.log('generated - excluded');",
      "frontend/src/index.js": "console.log('real source');",
      // "generated" is not excluded outside frontend/ - only that
      // nested .gitignore's own subtree is affected
      "backend/generated/keep.js": "console.log('not excluded here');",
    });
    const files = findSourceFiles(dir, [".js"], new Set());
    const relative = files.map((f) => path.relative(dir, f)).sort();
    assert.deepStrictEqual(relative, [
      path.join("backend", "generated", "keep.js"),
      path.join("frontend", "src", "index.js"),
    ]);
  });

  await test(".gitignore negation re-includes a specific path", async () => {
    const dir = makeFixture({
      // "artifacts" (unlike "build"/"dist") isn't in the hardcoded
      // safety list, so this exercises .gitignore negation itself
      ".gitignore": "artifacts/*\n!artifacts/keep.js\n",
      "artifacts/output.js": "console.log('excluded');",
      "artifacts/keep.js": "console.log('re-included');",
    });
    const files = findSourceFiles(dir, [".js"], new Set());
    assert.deepStrictEqual(
      files.map((f) => path.relative(dir, f)),
      [path.join("artifacts", "keep.js")]
    );
  });

  // ================= Nested repository boundary =================

  await test("A subdirectory with its own .git is treated as a separate repo, not scanned", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: {} }),
      "vendor/some-tool/.git/HEAD": "ref: refs/heads/main\n",
      "vendor/some-tool/index.js": "console.log('foreign repo - must not be scanned');",
      "index.js": "console.log('real source');",
    });
    const files = findSourceFiles(dir, [".js"], new Set());
    assert.deepStrictEqual(
      files.map((f) => path.relative(dir, f)),
      ["index.js"]
    );
  });

  await test("Nested repository boundary generalizes regardless of directory name", async () => {
    // The mechanism is "has its own .git", not a hardcoded name like
    // "cloned_repos" - any nested repo, anywhere, is excluded the
    // same way.
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: {} }),
      "third_party/random-name/.git/HEAD": "ref: refs/heads/main\n",
      "third_party/random-name/main.js": "console.log('foreign');",
    });
    const files = findSourceFiles(dir, [".js"], new Set());
    assert.deepStrictEqual(files, []);
  });

  await test("The analyzed root's own .git is not treated as a nested-repo exclusion", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: {} }),
      ".git/HEAD": "ref: refs/heads/main\n",
      "index.js": "console.log('this project's own source');",
    });
    const files = findSourceFiles(dir, [".js"], new Set());
    assert.deepStrictEqual(
      files.map((f) => path.relative(dir, f)),
      ["index.js"]
    );
  });

  await test("A nested repository is never discovered as a separate workspace root", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: {} }),
      "cloned_repos/repo-A/.git/HEAD": "ref: refs/heads/main\n",
      "cloned_repos/repo-A/package.json": JSON.stringify({ dependencies: { flask: "1.0.0" } }),
    });
    const roots = findWorkspaceRoots(dir);
    assert.deepStrictEqual(roots, [dir]);
  });

  // ================= Full CodeMap-style fixture =================

  await test("CodeMap-style fixture: cloned_repos and analysis never contribute usage or findings", async () => {
    const backend = makeFixture({
      ".gitignore": "cloned_repos/\nanalysis/\n",
      "requirements.txt": "gitpython\nrequests\n",
      "actual_source/main.py": "from git import Repo\nRepo.clone_from('x', 'y')\n",
      // A cloned repo with its own manifest AND its own git boundary -
      // doubly protected, and its "requests" import must never credit
      // the parent's declared "requests" dependency
      "cloned_repos/repo-A/.git/HEAD": "ref: refs/heads/main\n",
      "cloned_repos/repo-A/requirements.txt": "flask\n",
      "cloned_repos/repo-A/app.py": "import flask\nimport requests\n",
      "cloned_repos/repo-B/.git/HEAD": "ref: refs/heads/main\n",
      "cloned_repos/repo-B/app.py": "import django\n",
      // Generated analysis output - no .git, excluded purely by .gitignore
      "analysis/report.py": "import requests\nimport pandas\n",
    });

    const manifest = readManifest(backend);
    const result = await analyzeWorkspace(backend, manifest.dependencies, new Set());

    const scanned = result.files.map((f) => path.relative(backend, f));
    assert.deepStrictEqual(scanned, [path.join("actual_source", "main.py")]);

    assert.ok(isUsed(result.usage, "gitpython"), "gitpython should be detected via the git import mapping");
    assert.ok(
      !isUsed(result.usage, "requests"),
      "requests must not be credited from imports inside cloned_repos or analysis"
    );

    const roots = findWorkspaceRoots(backend);
    assert.deepStrictEqual(roots, [backend], "cloned_repos/repo-A's manifest must not become its own workspace");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
