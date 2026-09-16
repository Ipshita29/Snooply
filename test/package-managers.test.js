// Tests for the centralized package-manager abstraction: manifest
// detection, language association, dependency-metadata tagging, and
// uninstall/install command generation.
//
// Run with: node test/package-managers.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const {
  detectPackageManager,
  getPackageManager,
  languageFor,
  readManifest,
  uninstallCommandFor,
  installCommandFor,
} = require("../src/core/package-managers");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL - ${name}`);
    console.log(`  ${error.message}`);
  }
}

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-pm-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

// ================= Manifest -> manager detection =================

test("npm: package.json detected", () => {
  const dir = makeDir({ "package.json": "{}" });
  assert.strictEqual(detectPackageManager(dir), "npm");
});

test("pip: requirements.txt detected", () => {
  const dir = makeDir({ "requirements.txt": "" });
  assert.strictEqual(detectPackageManager(dir), "pip");
});

test("pip: pyproject.toml detected", () => {
  const dir = makeDir({ "pyproject.toml": "" });
  assert.strictEqual(detectPackageManager(dir), "pip");
});

test("maven: pom.xml detected", () => {
  const dir = makeDir({ "pom.xml": "<project></project>" });
  assert.strictEqual(detectPackageManager(dir), "maven");
});

test("gradle: build.gradle detected", () => {
  const dir = makeDir({ "build.gradle": "" });
  assert.strictEqual(detectPackageManager(dir), "gradle");
});

test("gradle: build.gradle.kts detected", () => {
  const dir = makeDir({ "build.gradle.kts": "" });
  assert.strictEqual(detectPackageManager(dir), "gradle");
});

test("go: go.mod detected", () => {
  const dir = makeDir({ "go.mod": "module example.com/app\n" });
  assert.strictEqual(detectPackageManager(dir), "go");
});

test("cargo: Cargo.toml detected", () => {
  const dir = makeDir({ "Cargo.toml": "[package]\nname = \"x\"\n" });
  assert.strictEqual(detectPackageManager(dir), "cargo");
});

test("unknown manifest does not resolve to any manager", () => {
  const dir = makeDir({ "random-dependency-file.txt": "not a real manifest" });
  assert.strictEqual(detectPackageManager(dir), null);
});

test("no manifest at all does not resolve to any manager", () => {
  const dir = makeDir({});
  assert.strictEqual(detectPackageManager(dir), null);
});

// ================= Maven vs Gradle stay distinct =================

test("Maven and Gradle are never collapsed into one id", () => {
  const mavenDir = makeDir({ "pom.xml": "<project></project>" });
  const gradleDir = makeDir({ "build.gradle": "" });
  assert.strictEqual(detectPackageManager(mavenDir), "maven");
  assert.strictEqual(detectPackageManager(gradleDir), "gradle");
  assert.notStrictEqual(detectPackageManager(mavenDir), detectPackageManager(gradleDir));
});

// npm vs pip stay distinct
test("npm and pip are never confused", () => {
  const npmDir = makeDir({ "package.json": "{}" });
  const pipDir = makeDir({ "requirements.txt": "" });
  assert.strictEqual(detectPackageManager(npmDir), "npm");
  assert.strictEqual(detectPackageManager(pipDir), "pip");
});

// ================= Language association =================

test("language association for every manager", () => {
  assert.strictEqual(languageFor("npm"), "javascript");
  assert.strictEqual(languageFor("pip"), "python");
  assert.strictEqual(languageFor("maven"), "java");
  assert.strictEqual(languageFor("gradle"), "java");
  assert.strictEqual(languageFor("go"), "go");
  assert.strictEqual(languageFor("cargo"), "rust");
});

test("unknown manager id has no language (never guesses)", () => {
  assert.strictEqual(languageFor("does-not-exist"), null);
});

test("getPackageManager returns null for an unknown id", () => {
  assert.strictEqual(getPackageManager("does-not-exist"), null);
});

// ================= Dependency metadata =================

test("readManifest tags each dependency with its real package manager", () => {
  const dir = makeDir({
    "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
  });
  const manifest = readManifest(dir);
  assert.strictEqual(manifest.packageManagers["axios"], "npm");
});

test("readManifest merges multiple ecosystems in one directory without losing attribution", () => {
  const dir = makeDir({
    "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
    "requirements.txt": "requests\n",
  });
  const manifest = readManifest(dir);
  assert.strictEqual(manifest.packageManagers["axios"], "npm");
  assert.strictEqual(manifest.packageManagers["requests"], "pip");
});

test("readManifest throws for a directory with no manifest at all", () => {
  const dir = makeDir({});
  assert.throws(() => readManifest(dir));
});

// ================= Uninstall / install commands =================

test("npm uninstall command is correct", () => {
  assert.strictEqual(uninstallCommandFor("npm", "axios"), "npm uninstall axios");
});

test("pip uninstall command is correct", () => {
  assert.strictEqual(uninstallCommandFor("pip", "pandas"), "pip uninstall pandas");
});

test("npm install command is correct", () => {
  assert.strictEqual(installCommandFor("npm", ["just-debounce-it"]), "npm install just-debounce-it");
});

test("maven has no fabricated uninstall command", () => {
  assert.strictEqual(uninstallCommandFor("maven", "com.example:foo"), null);
});

test("gradle has no fabricated uninstall command", () => {
  assert.strictEqual(uninstallCommandFor("gradle", "com.example:foo"), null);
});

test("go has no fabricated uninstall command", () => {
  assert.strictEqual(uninstallCommandFor("go", "github.com/example/foo"), null);
});

test("cargo has no fabricated uninstall command", () => {
  assert.strictEqual(uninstallCommandFor("cargo", "some-crate"), null);
});

// ================= Nested / mixed-language projects =================

test("nested package boundaries each keep their own manager", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-pm-test-"));
  fs.mkdirSync(path.join(dir, "frontend"), { recursive: true });
  fs.mkdirSync(path.join(dir, "backend"), { recursive: true });
  fs.writeFileSync(path.join(dir, "frontend", "package.json"), "{}");
  fs.writeFileSync(path.join(dir, "backend", "requirements.txt"), "");

  assert.strictEqual(detectPackageManager(path.join(dir, "frontend")), "npm");
  assert.strictEqual(detectPackageManager(path.join(dir, "backend")), "pip");
});

test("mixed-language monorepo: each service resolves independently", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-pm-test-"));
  const services = {
    frontend: "package.json",
    "java-service": "pom.xml",
    "go-service": "go.mod",
    "rust-service": "Cargo.toml",
  };
  for (const [name, manifest] of Object.entries(services)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, manifest), manifest === "go.mod" ? "module example.com/x\n" : "");
  }

  assert.strictEqual(detectPackageManager(path.join(dir, "frontend")), "npm");
  assert.strictEqual(detectPackageManager(path.join(dir, "java-service")), "maven");
  assert.strictEqual(detectPackageManager(path.join(dir, "go-service")), "go");
  assert.strictEqual(detectPackageManager(path.join(dir, "rust-service")), "cargo");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
