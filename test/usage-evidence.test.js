// Regression tests for non-import usage evidence: package-manager
// scripts and real CLI invocations in Makefiles, shell scripts,
// Dockerfiles, docker-compose files, and CI workflow configs. The
// rule under test throughout is that "no source import" is never the
// same as "unused" when a dependency is genuinely invoked as a
// command - and that a prose mention (a README sentence, a comment)
// is never mistaken for a real command.
//
// Run with: node test/usage-evidence.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { collectNonImportEvidence, EVIDENCE } = require("../src/usage-evidence");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-evidence-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

function typesFor(evidence, dep) {
  return (evidence[dep] || []).map((e) => e.type);
}

(async () => {
  // ================= package.json scripts =================

  await test("npm script usage counts as PACKAGE_SCRIPT evidence", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({
        scripts: { dev: "vite", build: "vite build", lint: "eslint ." },
      }),
    });
    const evidence = collectNonImportEvidence(dir, new Set(["vite", "eslint", "unused-thing"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "vite"), [EVIDENCE.PACKAGE_SCRIPT, EVIDENCE.PACKAGE_SCRIPT]);
    assert.deepStrictEqual(typesFor(evidence, "eslint"), [EVIDENCE.PACKAGE_SCRIPT]);
    assert.deepStrictEqual(typesFor(evidence, "unused-thing"), []);
  });

  await test("A script argument matching an unrelated package name is not evidence for it", async () => {
    // Only the command position counts - "my-vite-folder" is an
    // argument here, not a command, and must not credit any package
    // named "my-vite-folder" if one happened to be declared.
    const dir = makeFixture({
      "package.json": JSON.stringify({ scripts: { clean: "rimraf my-vite-folder" } }),
    });
    const evidence = collectNonImportEvidence(dir, new Set(["my-vite-folder", "rimraf"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "my-vite-folder"), []);
    assert.deepStrictEqual(typesFor(evidence, "rimraf"), [EVIDENCE.PACKAGE_SCRIPT]);
  });

  // ================= CLI commands =================

  await test("Makefile recipe command counts as CLI_COMMAND evidence", async () => {
    const dir = makeFixture({
      Makefile: "dev:\n\tuvicorn main:app --reload\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), [EVIDENCE.CLI_COMMAND]);
  });

  await test("Dockerfile RUN/CMD command counts as CLI_COMMAND evidence (shell and exec form)", async () => {
    const dir = makeFixture({
      Dockerfile: ["FROM python:3.11", "RUN pip install -r requirements.txt", 'CMD ["gunicorn", "app:app"]'].join("\n"),
    });
    const evidence = collectNonImportEvidence(dir, new Set(["gunicorn", "pip"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "gunicorn"), [EVIDENCE.CLI_COMMAND]);
  });

  await test("docker-compose command: line counts as CLI_COMMAND evidence", async () => {
    const dir = makeFixture({
      "docker-compose.yml": ["services:", "  api:", "    command: uvicorn main:app --host 0.0.0.0"].join("\n"),
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), [EVIDENCE.CLI_COMMAND]);
  });

  await test("CI workflow run: step (inline and block-scalar) counts as CLI_COMMAND evidence", async () => {
    const dir = makeFixture({
      ".github/workflows/ci.yml": [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: pytest",
        "      - run: |",
        "          pip install -r requirements.txt",
        "          ruff check .",
      ].join("\n"),
    });
    const evidence = collectNonImportEvidence(dir, new Set(["pytest", "ruff"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "pytest"), [EVIDENCE.CLI_COMMAND]);
    assert.deepStrictEqual(typesFor(evidence, "ruff"), [EVIDENCE.CLI_COMMAND]);
  });

  await test("A .yml file outside .github/workflows is not treated as a CI config", async () => {
    const dir = makeFixture({
      "config/pytest.yml": "run: pytest\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["pytest"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "pytest"), []);
  });

  await test("`python -m X` invocation also credits the launched module X", async () => {
    const dir = makeFixture({
      Makefile: "dev:\n\tpython -m uvicorn main:app --reload\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), [EVIDENCE.CLI_COMMAND]);
  });

  await test("Shell script command counts as CLI_COMMAND evidence", async () => {
    const dir = makeFixture({
      "scripts/start.sh": "#!/bin/sh\npip install -r requirements.txt\ngunicorn app:app\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["gunicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "gunicorn"), [EVIDENCE.CLI_COMMAND]);
  });

  // ================= README: prose vs. real command =================

  await test("A prose mention of a package in README is NOT evidence", async () => {
    const dir = makeFixture({
      "README.md": "You can install uvicorn with pip, then run the server manually.\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), []);
  });

  await test("A real command inside a README code fence IS evidence, distinct from surrounding prose", async () => {
    const dir = makeFixture({
      "README.md": [
        "You can install uvicorn with pip.",
        "",
        "```",
        "uvicorn main:app --reload",
        "```",
        "",
        "That's all you need to start the dev server.",
      ].join("\n"),
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), [EVIDENCE.CLI_COMMAND]);
  });

  // ================= Boundary safety =================

  await test("Evidence for one dependency is never credited to an unrelated sibling", async () => {
    const dir = makeFixture({
      Makefile: "dev:\n\tuvicorn main:app --reload\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn", "gunicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), [EVIDENCE.CLI_COMMAND]);
    assert.deepStrictEqual(typesFor(evidence, "gunicorn"), []);
  });

  await test("Evidence scanning respects ignored directories - a Makefile inside node_modules is never scanned", async () => {
    const dir = makeFixture({
      "node_modules/some-pkg/Makefile": "dev:\n\tuvicorn main:app --reload\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), []);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
