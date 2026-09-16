// Focused regression tests for the JavaScript/TypeScript (Babel-based)
// analyzer: import forms, TypeScript-only syntax, .tsx JSX, .d.ts
// exclusion, the intentional decorator limitation, and JS+TS+JSX
// coexisting in one workspace. Runs the real analyzer pipeline.
//
// Run with: node test/javascript-typescript.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-jsts-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

async function usageFor(dir, deps) {
  const { usage } = await analyzeWorkspace(dir, new Set(deps), new Set());
  return usage;
}

function isUsed(usage, dep) {
  return Boolean(usage[dep]) && usage[dep].size > 0;
}

(async () => {
  // ================= JavaScript import forms =================

  await test("JS: default import", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": 'import axios from "axios";\naxios.get("/x");',
    });
    assert.ok(isUsed(await usageFor(dir, ["axios"]), "axios"));
  });

  await test("JS: named import", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "index.js": 'import { debounce } from "lodash";\ndebounce();',
    });
    assert.ok(isUsed(await usageFor(dir, ["lodash"]), "lodash"));
  });

  await test("JS: namespace import", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "index.js": 'import * as _ from "lodash";\n_.debounce(() => {}, 10);',
    });
    assert.ok(isUsed(await usageFor(dir, ["lodash"]), "lodash"));
  });

  await test("JS: side-effect import", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { "some-polyfill": "1.0.0" } }),
      "index.js": 'import "some-polyfill";',
    });
    assert.ok(isUsed(await usageFor(dir, ["some-polyfill"]), "some-polyfill"));
  });

  await test("JS: CommonJS require", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": 'const axios = require("axios");\naxios.get("/x");',
    });
    assert.ok(isUsed(await usageFor(dir, ["axios"]), "axios"));
  });

  await test("JS: package subpath resolves to the root dependency", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "index.js": 'import debounce from "lodash/debounce";',
    });
    assert.ok(isUsed(await usageFor(dir, ["lodash"]), "lodash"));
  });

  await test("JS: used dependency produces no usage-based finding gap (positive case)", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": 'const axios = require("axios");\naxios.get("/x");',
    });
    assert.ok(isUsed(await usageFor(dir, ["axios"]), "axios"));
  });

  await test("JS: genuinely unused dependency", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": "console.log('hi');",
    });
    assert.ok(!isUsed(await usageFor(dir, ["axios"]), "axios"));
  });

  await test("JS + JSX in the same project", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { react: "18.2.0", axios: "1.0.0" } }),
      "App.jsx": 'const React = require("react");\nfunction App() { return <div>hi</div>; }',
      "api.js": 'const axios = require("axios");\naxios.get("/x");',
    });
    const usage = await usageFor(dir, ["react", "axios"]);
    assert.ok(isUsed(usage, "react"));
    assert.ok(isUsed(usage, "axios"));
  });

  // ================= TypeScript import forms =================

  await test("TS: default/named/namespace imports all resolve", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0", lodash: "1.0.0", moment: "1.0.0" } }),
      "index.ts": [
        'import axios from "axios";',
        'import { debounce } from "lodash";',
        'import * as moment from "moment";',
        "axios.get('/x'); debounce(); moment.now();",
      ].join("\n"),
    });
    const usage = await usageFor(dir, ["axios", "lodash", "moment"]);
    assert.ok(isUsed(usage, "axios"));
    assert.ok(isUsed(usage, "lodash"));
    assert.ok(isUsed(usage, "moment"));
  });

  await test("TS: dynamic import", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "index.ts": 'async function load() { const mod = await import("lodash"); return mod; }',
    });
    assert.ok(isUsed(await usageFor(dir, ["lodash"]), "lodash"));
  });

  await test("TS: package subpath", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { "@babel/parser": "1.0.0" } }),
      "index.ts": 'import x from "@babel/parser/lib/index.js";',
    });
    assert.ok(isUsed(await usageFor(dir, ["@babel/parser"]), "@babel/parser"));
  });

  await test("TS: interfaces, type aliases, enums, generics, and 'as' all parse successfully", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.ts": [
        'import axios from "axios";',
        "interface User { id: number; name?: string; }",
        "type UserId = string | number;",
        "enum Color { Red, Green, Blue }",
        "function identity<T>(x: T): T { return x; }",
        "const raw = {} as User;",
        "axios.get('/x');",
      ].join("\n"),
    });
    const result = await analyzeWorkspace(dir, new Set(["axios"]), new Set());
    assert.strictEqual(result.skippedFiles.length, 0, "TS syntax should parse without being skipped");
    assert.ok(result.usage["axios"].size > 0);
  });

  await test("TSX: JSX usage counts as react usage", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { react: "18.2.0" } }),
      "App.tsx": [
        'import React from "react";',
        "export default function App(): JSX.Element {",
        "  return <div>Hello</div>;",
        "}",
      ].join("\n"),
    });
    assert.ok(isUsed(await usageFor(dir, ["react"]), "react"));
  });

  await test(".d.ts files are ignored as source (not scanned, not counted)", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: {} }),
      "App.tsx": "export default function App(): null { return null; }",
      "types.ts": "export interface Config { id: number; }",
      "global.d.ts": "declare global { interface Window { x: string; } }\nexport {};",
    });
    const result = await analyzeWorkspace(dir, new Set(), new Set());
    const scannedNames = result.files.map((f) => path.basename(f)).sort();
    assert.deepStrictEqual(scannedNames, ["App.tsx", "types.ts"]);
  });

  await test("TS: decorator syntax fails gracefully (skipped, not crashed) and siblings still analyze", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "app.ts": '@Component({ selector: "app-root" })\nclass App {}\n',
      "api.ts": 'import axios from "axios";\naxios.get("/x");',
    });
    const result = await analyzeWorkspace(dir, new Set(["axios"]), new Set());
    assert.ok(result.skippedFiles.some((f) => f.endsWith("app.ts")), "decorator file should be skipped");
    assert.ok(result.usage["axios"].size > 0, "sibling file should still be analyzed");
  });

  await test("Mixed JS + TS + TSX: both analyzers run with no duplicate or missing results", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { react: "18.2.0", axios: "1.0.0", lodash: "1.0.0" } }),
      "src/App.js": 'const React = require("react");\nfunction App() { return React.createElement("div"); }',
      "src/utils.ts": 'import { debounce } from "lodash";\ndebounce();',
      "src/Component.tsx": 'import React from "react";\nexport default function C(): JSX.Element { return <div />; }',
    });
    const result = await analyzeWorkspace(dir, new Set(["react", "axios", "lodash"]), new Set());
    assert.deepStrictEqual([...result.languages].sort(), ["javascript", "typescript"]);
    assert.ok(isUsed(result.usage, "react"));
    assert.ok(isUsed(result.usage, "lodash"));
    assert.ok(!isUsed(result.usage, "axios"));
    // react is used from both App.js and Component.tsx - must be merged, not duplicated
    assert.strictEqual(result.usageByFile["react"].length, 2);
    const files = result.usageByFile["react"].map((entry) => path.basename(entry.file)).sort();
    assert.deepStrictEqual(files, ["App.js", "Component.tsx"]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
