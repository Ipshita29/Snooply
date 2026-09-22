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

  // ================= Local wrapper-script following =================

  await test("Direct command (no wrapper) still counts as evidence", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ scripts: { dev: "uvicorn main:app --reload" } }),
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), [EVIDENCE.PACKAGE_SCRIPT]);
  });

  await test("npm script -> local wrapper shell script: the wrapped command is followed", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ scripts: { dev: "./scripts/dev.sh" } }),
      "scripts/dev.sh": "#!/bin/sh\nuvicorn main:app --reload\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.ok(typesFor(evidence, "uvicorn").includes(EVIDENCE.CLI_COMMAND), JSON.stringify(evidence));
  });

  await test("Makefile -> local wrapper shell script: the wrapped command is followed", async () => {
    const dir = makeFixture({
      Makefile: "dev:\n\t./scripts/dev.sh\n",
      "scripts/dev.sh": "uvicorn main:app --reload\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    // scripts/dev.sh is found both directly (it's independently scanned
    // as a *.sh file) and via following the Makefile's reference to it -
    // duplicate evidence entries are harmless, only presence is checked
    assert.ok(typesFor(evidence, "uvicorn").includes(EVIDENCE.CLI_COMMAND), JSON.stringify(evidence));
  });

  await test("Package-manager command -> local executable with no recognized extension is still followed", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ scripts: { dev: "./scripts/dev" } }),
      "scripts/dev": "#!/bin/sh\nuvicorn main:app --reload\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.ok(typesFor(evidence, "uvicorn").includes(EVIDENCE.CLI_COMMAND), JSON.stringify(evidence));
  });

  await test("Nested wrapper: a chain of scripts (a -> b -> c) is followed to the real command", async () => {
    const dir = makeFixture({
      Makefile: "dev:\n\t./scripts/a.sh\n",
      "scripts/a.sh": "./scripts/b.sh\n",
      "scripts/b.sh": "./scripts/c.sh\n",
      "scripts/c.sh": "uvicorn main:app --reload\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), [EVIDENCE.CLI_COMMAND]);
  });

  await test("Missing script: a reference to a script that doesn't exist is not evidence and does not crash", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ scripts: { dev: "./scripts/missing.sh" } }),
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), []);
  });

  await test("Circular script references terminate instead of looping forever", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ scripts: { dev: "./scripts/a.sh" } }),
      "scripts/a.sh": "./scripts/b.sh\n",
      "scripts/b.sh": "./scripts/a.sh\nuvicorn main:app --reload\n",
    });
    const start = Date.now();
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    const elapsedMs = Date.now() - start;
    assert.ok(elapsedMs < 2000, `circular reference should resolve quickly, took ${elapsedMs}ms`);
    assert.ok(typesFor(evidence, "uvicorn").includes(EVIDENCE.CLI_COMMAND), JSON.stringify(evidence));
  });

  await test("Unrelated text mentioning the command in a wrapper script's comment is not evidence", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ scripts: { dev: "./scripts/dev.sh" } }),
      "scripts/dev.sh": "# uvicorn is installed separately, not run from here\necho hi\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), []);
  });

  await test("A followed wrapper script respects .gitignore - a target inside an ignored directory is not read", async () => {
    const dir = makeFixture({
      ".gitignore": "cache_data/\n",
      "package.json": JSON.stringify({ scripts: { dev: "./cache_data/dev.sh" } }),
      "cache_data/dev.sh": "uvicorn main:app --reload\n",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), []);
  });

  await test("A wrapper reference cannot escape the project root via ../", async () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-evidence-test-"));
    fs.mkdirSync(path.join(outer, "project"));
    fs.writeFileSync(
      path.join(outer, "project", "package.json"),
      JSON.stringify({ scripts: { dev: "../outside.sh" } })
    );
    fs.writeFileSync(path.join(outer, "outside.sh"), "uvicorn main:app --reload\n");

    const evidence = collectNonImportEvidence(path.join(outer, "project"), new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), []);
  });

  await test("A bare command name (no path) is never followed as a file, even if a same-named local file exists", async () => {
    // "uvicorn" here is a bare $PATH-resolved command, not a reference
    // to the local file "uvicorn" that happens to sit next to it -
    // only an explicit relative path ("./uvicorn") is ever followed.
    const dir = makeFixture({
      "package.json": JSON.stringify({ scripts: { dev: "uvicorn main:app --reload" } }),
      uvicorn: "this file must never be read as a wrapper script",
    });
    const evidence = collectNonImportEvidence(dir, new Set(["uvicorn"]), new Set());
    assert.deepStrictEqual(typesFor(evidence, "uvicorn"), [EVIDENCE.PACKAGE_SCRIPT]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
