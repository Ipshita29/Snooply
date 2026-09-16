// One realistic-sized fixture, mainly to catch an accidental duplicate
// full-project scan (e.g. a workspace being walked twice, or a
// dependency's usage being recorded more than once per file) - the
// kind of bug that's invisible on the tiny single-file fixtures used
// everywhere else in this suite but shows up immediately once there
// are enough files for a duplicate to double a count.
//
// Run with: node test/performance.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { analyzeWorkspace } = require("../src/core/analyzer");

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

// Build a moderately large, deterministic project: a few dozen
// directories, several files each, a known and fixed number of which
// import a given dependency - so any deviation in the counts below can
// only come from scanning something more than once.
function buildLargeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-perf-test-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ dependencies: { axios: "1.0.0", lodash: "1.0.0", unused: "1.0.0" } })
  );

  const dirCount = 20;
  const filesPerDir = 10;
  let axiosImporters = 0;

  for (let d = 0; d < dirCount; d++) {
    const subDir = path.join(dir, "src", `module-${d}`);
    fs.mkdirSync(subDir, { recursive: true });

    for (let f = 0; f < filesPerDir; f++) {
      // Every third file imports axios; none import lodash or unused -
      // both should end up with a precisely known usage count.
      const usesAxios = f % 3 === 0;
      if (usesAxios) axiosImporters++;

      const code = usesAxios
        ? `const axios = require("axios");\nmodule.exports = () => axios.get("/x");\n`
        : `module.exports = () => console.log("file-${d}-${f}");\n`;

      fs.writeFileSync(path.join(subDir, `file${f}.js`), code);
    }
  }

  return { dir, totalFiles: dirCount * filesPerDir, axiosImporters };
}

(async () => {
  await test("Large project: file and usage counts are exact, not duplicated", async () => {
    const { dir, totalFiles, axiosImporters } = buildLargeFixture();

    const start = Date.now();
    const result = await analyzeWorkspace(dir, new Set(["axios", "lodash", "unused"]), new Set());
    const elapsedMs = Date.now() - start;

    assert.strictEqual(result.files.length, totalFiles, "every source file should be scanned exactly once");
    assert.strictEqual(
      result.usageByFile["axios"].length,
      axiosImporters,
      "each importing file should be credited exactly once - a duplicate scan would double this"
    );
    assert.strictEqual(result.usage["lodash"].size, 0);
    assert.strictEqual(result.usage["unused"].size, 0);

    // Generous bound - this is a sanity check against accidental
    // quadratic/duplicate scanning, not a strict performance budget.
    assert.ok(elapsedMs < 10000, `analysis took ${elapsedMs}ms, which is far more than expected for ${totalFiles} tiny files`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
