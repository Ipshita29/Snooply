// Regression tests for recommendation confidence: HIGH findings show
// with unchanged wording, MEDIUM findings show with cautious wording,
// and LOW findings are suppressed entirely rather than shown as a
// noisy "maybe". Runs the real analyzer pipeline end to end - nothing
// here re-implements the confidence rules separately.
//
// Run with: node test/confidence.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { readManifest } = require("../src/package-managers");
const { analyzeWorkspace } = require("../src/analyze");
const { buildResults } = require("../src/recommendations");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-confidence-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

// Run the real pipeline: manifest -> analyzers -> recommendation engine
async function findingsFor(dir) {
  const manifest = readManifest(dir);
  const { usage, files, skippedFiles, matchConfidence, nonImportEvidence } = await analyzeWorkspace(
    dir,
    manifest.dependencies,
    new Set()
  );
  return buildResults(usage, manifest.devDependencyNames, {
    skippedFiles,
    totalFiles: files.length,
    matchConfidence,
    evidence: nonImportEvidence,
  });
}

function findingFor(result, dependency) {
  return [...result.recommendations, ...result.unused].find((item) => item.dependency === dependency);
}

// Make `count` of a directory's files unreadable (simulates a parse
// failure without needing genuinely broken syntax)
function makeUnreadable(paths) {
  for (const p of paths) fs.chmodSync(p, 0o000);
}
function restoreReadable(paths) {
  for (const p of paths) fs.chmodSync(p, 0o644);
}

(async () => {
  // ================= HIGH confidence =================

  await test("HIGH: genuinely unused dependency, no parse failures", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": "console.log('hi');",
    });
    const result = await findingsFor(dir);
    const finding = findingFor(result, "axios");
    assert.ok(finding);
    assert.strictEqual(finding.confidence, "HIGH");
    assert.ok(!finding.reason.includes("couldn't be checked"));
  });

  await test("HIGH: clearly used dependency produces no finding at all", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": "const axios = require('axios'); axios.get('/x');",
    });
    const result = await findingsFor(dir);
    assert.strictEqual(findingFor(result, "axios"), undefined);
  });

  await test("HIGH: known alternative with strong evidence", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "index.js": "const { debounce } = require('lodash'); debounce();",
    });
    const result = await findingsFor(dir);
    const finding = findingFor(result, "lodash");
    assert.ok(finding);
    assert.strictEqual(finding.confidence, "HIGH");
    assert.strictEqual(finding.hasAlternative, true);
  });

  await test("HIGH: known alternative for lodash throttle usage", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "index.js": "const { throttle } = require('lodash'); throttle();",
    });
    const result = await findingsFor(dir);
    const finding = findingFor(result, "lodash");
    assert.ok(finding);
    assert.strictEqual(finding.confidence, "HIGH");
    assert.strictEqual(finding.hasAlternative, true);
  });

  // ================= MEDIUM confidence =================

  await test("MEDIUM: unused conclusion when a minority of files failed to parse", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "a.js": "console.log(1);",
      "b.js": "console.log(2);",
      "c.js": "console.log(3);",
    });
    const brokenFile = path.join(dir, "c.js");
    makeUnreadable([brokenFile]);
    try {
      const result = await findingsFor(dir);
      const finding = findingFor(result, "axios");
      assert.ok(finding, "MEDIUM findings should still be shown");
      assert.strictEqual(finding.confidence, "MEDIUM");
      assert.ok(finding.reason.includes("couldn't be checked"));
    } finally {
      restoreReadable([brokenFile]);
    }
  });

  await test("MEDIUM: known alternative reached only through a less-direct mapping", async () => {
    // Java: no curated ARTIFACT_TO_NAMESPACE entry for this artifact,
    // so it's only matched via the groupId fallback - less certain
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.example</groupId><artifactId>somelib</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": "import com.example.util.Helper;\nclass App {}",
    });
    const result = await findingsFor(dir);
    // This dependency has usage evidence (Helper import), so it never
    // becomes UNUSED - the point here is just that a "medium" mapping
    // hint doesn't crash anything and never gets treated as high.
    const manifest = readManifest(dir);
    const { matchConfidence } = await analyzeWorkspace(dir, manifest.dependencies, new Set());
    assert.strictEqual(matchConfidence["com.example:somelib"], "medium");
  });

  // ================= LOW confidence (suppressed) =================

  await test("LOW: unused conclusion suppressed when most files failed to parse", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "a.js": "console.log(1);",
      "b.js": "console.log(2);",
    });
    const broken = [path.join(dir, "a.js"), path.join(dir, "b.js")];
    makeUnreadable(broken);
    try {
      const result = await findingsFor(dir);
      assert.strictEqual(findingFor(result, "axios"), undefined, "LOW-confidence findings must be suppressed");
    } finally {
      restoreReadable(broken);
    }
  });

  await test("LOW: suppressed finding does not appear in either recommendations or unused arrays", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "a.js": "const { debounce } = require('lodash'); debounce();",
    });
    const broken = [path.join(dir, "a.js")];
    makeUnreadable(broken);
    try {
      const result = await findingsFor(dir);
      assert.strictEqual(result.recommendations.length, 0);
      assert.strictEqual(result.unused.length, 0);
    } finally {
      restoreReadable(broken);
    }
  });

  // ================= Cross-language =================

  await test("Confidence works the same way across all six languages", async () => {
    const cases = [
      { manifest: "package.json", content: JSON.stringify({ dependencies: { axios: "1.0.0" } }), src: "index.js", code: "console.log(1);", dep: "axios" },
      { manifest: "package.json", content: JSON.stringify({ dependencies: { axios: "1.0.0" } }), src: "index.ts", code: "const x: number = 1;", dep: "axios" },
      { manifest: "requirements.txt", content: "requests\n", src: "main.py", code: "print('hi')\n", dep: "requests" },
      { manifest: "pom.xml", content: `<project><dependencies><dependency><groupId>com.unused</groupId><artifactId>unused-lib</artifactId></dependency></dependencies></project>`, src: "src/main/java/App.java", code: "class App {}", dep: "com.unused:unused-lib" },
      { manifest: "go.mod", content: "module example.com/app\n\nrequire github.com/example/unused v1.0.0\n", src: "main.go", code: "package main\nfunc main() {}", dep: "github.com/example/unused" },
      { manifest: "Cargo.toml", content: '[dependencies]\nunused-crate = "1.0"\n', src: "src/main.rs", code: "fn main() {}", dep: "unused-crate" },
    ];

    for (const c of cases) {
      const dir = makeFixture({ [c.manifest]: c.content, [c.src]: c.code });
      const result = await findingsFor(dir);
      const finding = findingFor(result, c.dep);
      assert.ok(finding, `expected a finding for ${c.dep}`);
      assert.strictEqual(finding.confidence, "HIGH");
    }
  });

  // ================= Mixed-language / monorepo =================

  await test("Mixed-language project: confidence computed per package boundary independently", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-confidence-test-"));

    fs.mkdirSync(path.join(dir, "frontend", "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "frontend", "package.json"), JSON.stringify({ dependencies: { axios: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "frontend", "src", "index.js"), "console.log('unused');");

    fs.mkdirSync(path.join(dir, "backend"), { recursive: true });
    fs.writeFileSync(path.join(dir, "backend", "requirements.txt"), "requests\n");
    fs.writeFileSync(path.join(dir, "backend", "main.py"), "import requests\nrequests.get('/x')\n");

    const frontendResult = await findingsFor(path.join(dir, "frontend"));
    const backendResult = await findingsFor(path.join(dir, "backend"));

    const axiosFinding = findingFor(frontendResult, "axios");
    assert.ok(axiosFinding);
    assert.strictEqual(axiosFinding.confidence, "HIGH");
    assert.strictEqual(findingFor(backendResult, "requests"), undefined); // genuinely used
  });

  await test("Monorepo: a parse failure in one package boundary does not affect another's confidence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-confidence-test-"));

    fs.mkdirSync(path.join(dir, "service-a"), { recursive: true });
    fs.writeFileSync(path.join(dir, "service-a", "package.json"), JSON.stringify({ dependencies: { axios: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "service-a", "broken.js"), "console.log(1);");

    fs.mkdirSync(path.join(dir, "service-b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "service-b", "package.json"), JSON.stringify({ dependencies: { lodash: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "service-b", "index.js"), "console.log('unused');");

    const brokenFile = path.join(dir, "service-a", "broken.js");
    makeUnreadable([brokenFile]);
    try {
      const resultA = await findingsFor(path.join(dir, "service-a"));
      const resultB = await findingsFor(path.join(dir, "service-b"));

      // service-a's only file is unreadable -> total unreadable -> suppressed
      assert.strictEqual(findingFor(resultA, "axios"), undefined);

      // service-b is completely unaffected by service-a's broken file
      const lodashFinding = findingFor(resultB, "lodash");
      assert.ok(lodashFinding);
      assert.strictEqual(lodashFinding.confidence, "HIGH");
    } finally {
      restoreReadable([brokenFile]);
    }
  });

  // ================= Self-exclusion =================

  await test("Snooply never flags itself as unused, even if listed as a dependency", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { snooply: "1.0.0" } }),
      "index.js": "console.log('hi');",
    });
    const result = await findingsFor(dir);
    assert.strictEqual(findingFor(result, "snooply"), undefined);
    assert.strictEqual(result.unused.length, 0);
    assert.strictEqual(result.recommendations.length, 0);
  });

  await test("Excluding Snooply does not hide a genuinely unused sibling dependency", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { snooply: "1.0.0", axios: "1.0.0" } }),
      "index.js": "console.log('hi');",
    });
    const result = await findingsFor(dir);
    assert.strictEqual(findingFor(result, "snooply"), undefined);
    const axiosFinding = findingFor(result, "axios");
    assert.ok(axiosFinding, "a real unused dependency must still be flagged");
    assert.strictEqual(axiosFinding.confidence, "HIGH");
  });

  // ================= Non-import usage evidence =================

  await test("HIGH: a CLI-invoked dependency (uvicorn via Makefile) is never flagged unused", async () => {
    const dir = makeFixture({
      "requirements.txt": "uvicorn\n",
      "app.py": "print('server code, no direct uvicorn import')\n",
      Makefile: "dev:\n\tuvicorn main:app --reload\n",
    });
    const result = await findingsFor(dir);
    assert.strictEqual(findingFor(result, "uvicorn"), undefined);
  });

  await test("HIGH: a package-script-invoked dependency is never flagged unused, even as a prod dependency", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({
        dependencies: { vitest: "1.0.0" },
        scripts: { test: "vitest run" },
      }),
      "index.js": "console.log('hi');",
    });
    const result = await findingsFor(dir);
    assert.strictEqual(findingFor(result, "vitest"), undefined);
  });

  await test("MEDIUM: a framework-shaped name with zero evidence is downgraded, not suppressed", async () => {
    // "vite" has no import, no script, no CLI command anywhere in this
    // fixture - genuinely no evidence - but its name is a known
    // framework/build-tool shape, which is weaker grounds for "unused"
    // than an ordinary library in the same position.
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { vite: "1.0.0" } }),
      "index.js": "console.log('hi');",
    });
    const result = await findingsFor(dir);
    const finding = findingFor(result, "vite");
    assert.ok(finding, "still shown - not silently hidden just for having a familiar name");
    assert.strictEqual(finding.confidence, "MEDIUM");
    assert.ok(/framework|build tool|runtime/.test(finding.reason), finding.reason);
  });

  await test("Ambiguous dependency usage does not become HIGH confidence", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { webpack: "1.0.0" } }),
      "index.js": "console.log('hi');",
    });
    const result = await findingsFor(dir);
    const finding = findingFor(result, "webpack");
    assert.ok(finding);
    assert.notStrictEqual(finding.confidence, "HIGH");
  });

  await test("Genuinely unused, ordinary (non-framework) package is still detected at HIGH confidence", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": "console.log('hi');",
    });
    const result = await findingsFor(dir);
    const finding = findingFor(result, "axios");
    assert.ok(finding);
    assert.strictEqual(finding.confidence, "HIGH");
  });

  await test("CLI evidence for one dependency does not incorrectly credit an unrelated sibling", async () => {
    const dir = makeFixture({
      "requirements.txt": "uvicorn\ngunicorn\n",
      "app.py": "print('no direct imports of either')\n",
      Makefile: "dev:\n\tuvicorn main:app --reload\n",
    });
    const result = await findingsFor(dir);
    assert.strictEqual(findingFor(result, "uvicorn"), undefined, "uvicorn has real CLI evidence");
    const gunicornFinding = findingFor(result, "gunicorn");
    assert.ok(gunicornFinding, "gunicorn has no evidence at all and must still be flagged");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
