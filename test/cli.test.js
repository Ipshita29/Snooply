// Regression tests for the real CLI entry point (`node src/index.js`
// and `--verbose`), run as an actual subprocess rather than by
// calling library functions in-process - every other test file in
// this suite does the latter, so this one is what actually exercises
// src/index.js itself (argument parsing, workspace discovery, console
// output, exit codes).
//
// src/index.js is a self-executing script with no exports, and its
// normal path ends by spawning a detached Electron popup and waiting
// on it - there is no clean way to `require()` it directly without
// either triggering that popup or refactoring production code purely
// for testability (out of scope for this task). So each test spawns
// the CLI for real, captures stdout while all of its synchronous
// console output runs, then stops it:
//   - if it exits on its own first (the missing/malformed-manifest
//     early-return paths), that's used as-is;
//   - otherwise, after a short wait it's killed, and any detached
//     Electron popup process that appeared during *this* run is
//     killed too, identified by diffing the process list before/after
//     (never a blind `pkill`, so a real Snooply window a person has
//     open elsewhere is left alone).
//
// Run with: node test/cli.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { spawn, execSync } = require("child_process");

const CLI_PATH = path.join(__dirname, "..", "src", "index.js");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-cli-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

// Detached Electron popup windows this CLI itself spawned, identified
// by the specific script + protocol it launches with - not just any
// process that happens to mention "window.js".
function listPopupPids() {
  try {
    const out = execSync("ps -eo pid=,command=", { encoding: "utf-8" });
    const pids = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIndex = trimmed.indexOf(" ");
      if (spaceIndex === -1) continue;
      const pid = trimmed.slice(0, spaceIndex);
      const command = trimmed.slice(spaceIndex + 1);
      if (command.includes("window.js") && command.includes("http://127.0.0.1")) {
        pids.push(pid);
      }
    }
    return pids;
  } catch (error) {
    return [];
  }
}

function killPid(pid) {
  try {
    process.kill(Number(pid), "SIGKILL");
  } catch (error) {
    // already gone
  }
}

// Spawn the real CLI against a fixture directory and capture its
// stdout. Resolves as soon as the process exits on its own, or after
// `waitMs` otherwise (the normal case - it's waiting on the popup).
function runCli(cwd, args = [], waitMs = 1800) {
  return new Promise((resolve) => {
    const popupsBefore = new Set(listPopupPids());
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const pid of listPopupPids()) {
        if (!popupsBefore.has(pid)) killPid(pid);
      }
      resolve({ stdout, stderr, exitCode });
    };

    child.on("exit", (code) => finish(code));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, waitMs);
  });
}

(async () => {
  // ================= No findings =================

  await test("CLI: clean project with no findings prints the reassuring message", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": "const axios = require('axios'); axios.get('/x');",
    });
    const { stdout } = await runCli(dir);
    assert.ok(stdout.includes("Everything looks pretty reasonable"), stdout);
  });

  // ================= Unused dependency =================

  await test("CLI: a genuinely unused dependency is flagged by name", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": "console.log('hi');",
    });
    const { stdout } = await runCli(dir);
    assert.ok(stdout.includes("axios"), stdout);
    assert.ok(/found 1 thing/.test(stdout), stdout);
  });

  // ================= Known alternative recommendation =================

  await test("CLI: a known-alternative recommendation names the suggested package", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "index.js": "const { debounce } = require('lodash'); debounce();",
    });
    const { stdout } = await runCli(dir);
    assert.ok(stdout.includes("lodash"), stdout);
    assert.ok(stdout.includes("just-debounce-it"), stdout);
  });

  // ================= Multiple findings =================

  await test("CLI: multiple findings are all reported and counted correctly", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0", moment: "1.0.0" } }),
      "index.js": "console.log('hi');",
    });
    const { stdout } = await runCli(dir);
    assert.ok(/found 2 things/.test(stdout), stdout);
    assert.ok(stdout.includes("axios"), stdout);
    assert.ok(stdout.includes("moment"), stdout);
  });

  // ================= Mixed-language project =================

  await test("CLI: a mixed JS + Python workspace reports findings from both ecosystems", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": "console.log('unused');",
      "requirements.txt": "requests\n",
      "main.py": "print('unused')\n",
    });
    const { stdout } = await runCli(dir);
    assert.ok(stdout.includes("axios"), stdout);
    assert.ok(stdout.includes("requests"), stdout);
  });

  // ================= Multi-package monorepo =================

  await test("CLI: a multi-package monorepo labels findings by workspace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-cli-test-"));
    fs.mkdirSync(path.join(dir, "apps", "web"), { recursive: true });
    fs.mkdirSync(path.join(dir, "apps", "admin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "apps", "web", "package.json"), JSON.stringify({ dependencies: { axios: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "apps", "web", "index.js"), "console.log('unused');");
    fs.writeFileSync(path.join(dir, "apps", "admin", "package.json"), JSON.stringify({ dependencies: { moment: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "apps", "admin", "index.js"), "console.log('unused');");

    const { stdout } = await runCli(dir);
    assert.ok(stdout.includes("APPS/WEB"), stdout);
    assert.ok(stdout.includes("APPS/ADMIN"), stdout);
    assert.ok(stdout.includes("axios"), stdout);
    assert.ok(stdout.includes("moment"), stdout);
  });

  // ================= Missing manifest =================

  await test("CLI: missing manifest prints a clear message and exits non-zero", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-cli-test-"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "no manifest here");
    const { stdout, exitCode } = await runCli(dir);
    assert.ok(stdout.includes("couldn't find a package.json"), stdout);
    assert.strictEqual(exitCode, 1);
  });

  // ================= Malformed manifest =================

  await test("CLI: malformed package.json prints a clear message and exits non-zero", async () => {
    const dir = makeFixture({
      "package.json": "{ this is not valid JSON",
      "index.js": "console.log('hi');",
    });
    const { stdout, exitCode } = await runCli(dir);
    assert.ok(stdout.includes("couldn't read it"), stdout);
    assert.strictEqual(exitCode, 1);
  });

  // ================= Parser failure doesn't crash the run =================

  await test("CLI: a single unparseable file does not stop the rest of the analysis", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "broken.ts": '@Component({ selector: "app-root" })\nclass App {}\n',
      "index.ts": "const axios = require('axios'); axios.get('/x');",
    });
    const { stdout } = await runCli(dir, ["--verbose"]);
    assert.ok(stdout.includes("Could not parse"), stdout);
    assert.ok(stdout.includes("broken.ts"), stdout);
    // The readable sibling file's usage still gets reported
    assert.ok(stdout.includes("Everything looks pretty reasonable"), stdout);
  });

  // ================= --verbose =================

  await test("CLI --verbose: prints dependency usage and recommendation sections", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0", lodash: "1.0.0" } }),
      "index.js": [
        "const axios = require('axios'); axios.get('/x');",
        "const { debounce } = require('lodash'); debounce();",
      ].join("\n"),
    });
    const { stdout } = await runCli(dir, ["--verbose"]);
    assert.ok(stdout.includes("DEPENDENCY USAGE"), stdout);
    assert.ok(stdout.includes("RECOMMENDATIONS"), stdout);
    assert.ok(stdout.includes("SOURCE FILES"), stdout);
    assert.ok(stdout.includes("lodash"), stdout);
    assert.ok(stdout.includes("just-debounce-it"), stdout);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
