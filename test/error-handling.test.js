// Regression tests for how Snooply behaves when things go wrong:
// missing/malformed manifests, unreadable or unparseable source
// files, empty projects, and files planted inside directories that
// are supposed to be ignored. The rule under test throughout is that
// one broken file or directory must never crash analysis of the rest
// of the project.
//
// Run with: node test/error-handling.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { readManifest } = require("../src/core/package-managers");
const { analyzeWorkspace } = require("../src/core/analyzer");
const { IGNORED_DIRECTORIES } = require("../src/core/project");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-errors-test-"));
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

function makeUnreadable(filePath) {
  fs.chmodSync(filePath, 0o000);
}
function restoreReadable(filePath) {
  fs.chmodSync(filePath, 0o644);
}

(async () => {
  // ================= Manifest errors =================

  await test("Missing manifest: readManifest throws rather than guessing", async () => {
    const dir = makeFixture({ "index.js": "console.log('hi');" });
    assert.throws(() => readManifest(dir));
  });

  await test("Malformed manifest: invalid JSON in package.json throws", async () => {
    const dir = makeFixture({
      "package.json": "{ this is not valid JSON",
      "index.js": "console.log('hi');",
    });
    assert.throws(() => readManifest(dir));
  });

  await test("Malformed manifest: invalid JSON does not corrupt a sibling workspace's read", async () => {
    // Reading one broken manifest must not leave any shared state that
    // taints an unrelated, well-formed workspace read afterward.
    const broken = makeFixture({ "package.json": "{ not json" });
    assert.throws(() => readManifest(broken));

    const healthy = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
    });
    const manifest = readManifest(healthy);
    assert.ok(manifest.dependencies.has("axios"));
  });

  // ================= Unreadable / broken source files =================

  await test("Unreadable source file is skipped, not fatal - siblings still analyze", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "broken.js": "const axios = require('axios'); axios.get('/x');",
      "fine.js": "const axios = require('axios'); axios.get('/y');",
    });
    const brokenFile = path.join(dir, "broken.js");
    makeUnreadable(brokenFile);
    try {
      const result = await analyzeWorkspace(dir, new Set(["axios"]), new Set());
      assert.ok(result.skippedFiles.some((f) => f.endsWith("broken.js")));
      assert.ok(isUsed(result.usage, "axios"), "fine.js should still be analyzed");
    } finally {
      restoreReadable(brokenFile);
    }
  });

  await test("Invalid/unsupported JS syntax fails gracefully without crashing the run", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "broken.js": "const x = ((((;",
      "fine.js": "const axios = require('axios'); axios.get('/x');",
    });
    const result = await analyzeWorkspace(dir, new Set(["axios"]), new Set());
    assert.ok(result.skippedFiles.some((f) => f.endsWith("broken.js")));
    assert.ok(isUsed(result.usage, "axios"));
  });

  // Java/Go/Rust/Python analyzers scan source line-by-line rather than
  // fully parsing, so garbage content doesn't throw a parse error the
  // way Babel does - the requirement under test here is just that
  // unusual/invalid content never crashes the whole run.
  await test("Garbage Python content does not crash analysis of the workspace", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "broken.py": "def f(:::::garbage!!!\n",
      "main.py": "import requests\nrequests.get('/x')\n",
    });
    const result = await analyzeWorkspace(dir, new Set(["requests"]), new Set());
    assert.ok(isUsed(result.usage, "requests"));
  });

  await test("Garbage Java content does not crash analysis of the workspace", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.google.code.gson</groupId><artifactId>gson</artifactId></dependency></dependencies></project>`,
      "src/main/java/Broken.java": "class {{{ not valid java at all",
      "src/main/java/App.java": "import com.google.gson.Gson;\nclass App {}",
    });
    const result = await analyzeWorkspace(dir, new Set(["com.google.code.gson:gson"]), new Set());
    assert.ok(isUsed(result.usage, "com.google.code.gson:gson"));
  });

  await test("Garbage Go content does not crash analysis of the workspace", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
      "broken.go": "package main\nfunc {{{ nope",
      "main.go": 'package main\nimport "github.com/gin-gonic/gin"\nfunc main() { gin.Default() }',
    });
    const result = await analyzeWorkspace(dir, new Set(["github.com/gin-gonic/gin"]), new Set());
    assert.ok(isUsed(result.usage, "github.com/gin-gonic/gin"));
  });

  await test("Garbage Rust content does not crash analysis of the workspace", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nserde = "1.0"\n',
      "src/broken.rs": "fn (((( not valid rust",
      "src/main.rs": "use serde::Serialize;\nfn main() {}",
    });
    const result = await analyzeWorkspace(dir, new Set(["serde"]), new Set());
    assert.ok(isUsed(result.usage, "serde"));
  });

  // ================= Empty / minimal projects =================

  await test("Empty source directory: manifest present, no source files at all", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
    });
    const result = await analyzeWorkspace(dir, new Set(["axios"]), new Set());
    assert.deepStrictEqual(result.files, []);
    assert.ok(!isUsed(result.usage, "axios"));
  });

  await test("Project with no dependencies declared", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: {} }),
      "index.js": "console.log('hi');",
    });
    const manifest = readManifest(dir);
    assert.strictEqual(manifest.dependencies.size, 0);
    const result = await analyzeWorkspace(dir, manifest.dependencies, new Set());
    assert.deepStrictEqual(result.usage, {});
  });

  await test("No source files anywhere, and no manifest either", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-errors-test-"));
    const result = await analyzeWorkspace(dir, new Set(), new Set());
    assert.deepStrictEqual(result.languages, []);
    assert.deepStrictEqual(result.files, []);
  });

  // ================= Ignored directories =================

  await test("Ignored directories are never scanned as source, for every known ignored name", async () => {
    for (const ignoredName of IGNORED_DIRECTORIES) {
      const dir = makeFixture({
        "package.json": JSON.stringify({ dependencies: { "should-not-count": "1.0.0" } }),
        [`${ignoredName}/planted.js`]: `require("should-not-count");`,
      });
      const result = await analyzeWorkspace(dir, new Set(["should-not-count"]), new Set());
      assert.ok(
        !isUsed(result.usage, "should-not-count"),
        `a file planted inside "${ignoredName}" must not be scanned`
      );
      assert.strictEqual(result.files.length, 0, `"${ignoredName}" contents must not appear in scanned files`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
