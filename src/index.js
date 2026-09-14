#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const http = require("http");
const { spawn } = require("child_process");
const parser = require("@babel/parser");

// --- Status animation ---
//
// One updating line instead of a permanent scroll of messages. No fake
// percentages — just qualitative "Snooply is working" flavor text that
// rotates while real work happens.

const STATUS_MESSAGES = [
  "🐾 Snooply is snooping around your project...",
  "🐾 Snooply is sniffing through your dependencies...",
  "🐾 Snooply is having a little look...",
  "🐾 Snooply found something interesting...",
  "🐾 Snooply is putting the pieces together...",
];

function startStatusAnimation(messages, intervalMs = 1400) {
  let index = 0;
  process.stdout.write(messages[0]);

  const timer = setInterval(() => {
    index = (index + 1) % messages.length;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(messages[index]);
  }, intervalMs);

  return function stopStatusAnimation() {
    clearInterval(timer);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

// `excludedDirs` holds the absolute paths of OTHER workspaces nested inside
// this one (see findWorkspaceRoots below) — a workspace scans its own tree
// but never descends into a sibling/nested package, which is scanned
// separately as its own workspace. Empty for a plain single-package project,
// so existing behavior is unaffected.
function getJavaScriptFiles(directory, excludedDirs = new Set()) {
  const files = [];

  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    return files;
  }

  for (const item of entries) {
    if (IGNORED_DIRECTORIES.has(item)) {
      continue;
    }

    const fullPath = path.join(directory, item);

    if (excludedDirs.has(fullPath)) {
      continue;
    }

    let stats;
    try {
      stats = fs.statSync(fullPath);
    } catch (error) {
      continue;
    }

    if (stats.isDirectory()) {
      files.push(...getJavaScriptFiles(fullPath, excludedDirs));
    } else if (
      item.endsWith(".js") ||
      item.endsWith(".jsx")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

// Recursively finds every directory containing its own package.json, from
// startDir downward, skipping the same generated/dependency directories the
// analyzer already ignores. This is deliberately just "find package.json
// boundaries" rather than parsing a "workspaces" field or glob patterns —
// it naturally covers plain workspaces config, apps/*, packages/*, and any
// other layout, without needing to know about any of them specifically.
function findWorkspaceRoots(startDir) {
  const roots = [];

  function walk(dir) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      roots.push(dir);
    }

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      walk(path.join(dir, entry.name));
    }
  }

  walk(startDir);
  return roots;
}

// A short, human-readable label for a workspace — the path relative to the
// project root (e.g. "client", "apps/web"), or "root" for the top-level
// package itself. Only ever shown when more than one workspace exists.
function getWorkspaceLabel(root, projectPath) {
  const relative = path.relative(projectPath, root);
  return relative === "" ? "root" : relative.split(path.sep).join("/");
}

// Evidence markers that mean "this dependency is genuinely bound/used
// somewhere" but don't name a specific export — never counted as one of the
// "few specific functions" the recommendation engine looks for.
const NON_SPECIFIC_MARKERS = new Set(["default", "*", "JSX"]);

// Generic recursive walk over any Babel AST node — visits every node once.
// Deliberately untyped/shape-agnostic so it doesn't need updating whenever
// a new node type (JSX, dynamic import, etc.) shows up in real code.
function walkAst(node, visit) {
  if (!node || typeof node.type !== "string") {
    return;
  }

  visit(node);

  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") {
      continue;
    }

    const value = node[key];

    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") {
          walkAst(child, visit);
        }
      }
    } else if (value && typeof value.type === "string") {
      walkAst(value, visit);
    }
  }
}

// Explicit, curated globals for packages that are commonly loaded outside
// of any module system (a plain <script> tag / UMD build) rather than
// imported — e.g. Snooply's own popup UI loads React off a <script> tag and
// never writes `import React from "react"` anywhere. Deliberately NOT a
// heuristic like "capitalized identifier = dependency" — only these exact,
// documented global names for these exact packages ever count as evidence.
const GLOBAL_PACKAGE_BINDINGS = {
  react: ["React"],
  "react-dom": ["ReactDOM"],
  // react-router-dom's own UMD build publishes this as its global name —
  // not used anywhere in Snooply's own source, but included so the same
  // conservative mechanism works for projects that do load it this way.
  "react-router-dom": ["ReactRouterDOM"],
};

const GLOBAL_NAME_TO_PACKAGE = new Map();
for (const [pkg, globalNames] of Object.entries(GLOBAL_PACKAGE_BINDINGS)) {
  for (const globalName of globalNames) {
    GLOBAL_NAME_TO_PACKAGE.set(globalName, pkg);
  }
}

// Resolves an import/require source string to a tracked dependency name,
// understanding subpath imports like "react-dom/client" or "@scope/pkg/sub"
// — without this, those are invisible to a plain exact-string match.
function resolveTrackedPackage(source, dependencies) {
  if (typeof source !== "string") {
    return null;
  }
  if (dependencies.has(source)) {
    return source;
  }

  const segments = source.split("/");
  const base = source.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];

  return dependencies.has(base) ? base : null;
}

function isRequireCall(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require"
  );
}

function isDynamicImportCall(node) {
  return node?.type === "CallExpression" && node.callee.type === "Import";
}

function analyzeFile(code, dependencies, usage) {
  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx"],
  });

  // Pass 1: collect every import/require/dynamic-import binding in the
  // file, recording baseline evidence and remembering which local
  // identifier maps to which dependency (so pass 2 can attribute member
  // access like `axios.get(...)` or `_.debounce(...)`).
  const bindings = new Map();

  walkAst(ast.program, (node) => {
    if (node.type === "ImportDeclaration") {
      const pkg = resolveTrackedPackage(node.source.value, dependencies);
      if (!pkg) {
        return;
      }

      if (node.specifiers.length === 0) {
        // Side-effect-only import, e.g. `import "some-polyfill";` — it's
        // real usage, we just can't attribute it to a named export.
        usage[pkg].add("default");
      }

      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier") {
          usage[pkg].add(specifier.imported.name);
          bindings.set(specifier.local.name, { pkg, name: specifier.imported.name });
        } else if (specifier.type === "ImportDefaultSpecifier") {
          usage[pkg].add("default");
          bindings.set(specifier.local.name, { pkg, name: null });
        } else if (specifier.type === "ImportNamespaceSpecifier") {
          usage[pkg].add("*");
          bindings.set(specifier.local.name, { pkg, name: null });
        }
      }
      return;
    }

    if (node.type === "VariableDeclarator") {
      let init = node.init;
      if (init?.type === "AwaitExpression") {
        init = init.argument;
      }

      if (!isRequireCall(init) && !isDynamicImportCall(init)) {
        return;
      }

      const pkg = resolveTrackedPackage(init.arguments[0]?.value, dependencies);
      if (!pkg) {
        return;
      }

      if (node.id.type === "ObjectPattern") {
        for (const property of node.id.properties) {
          if (property.type === "ObjectProperty" && property.key.type === "Identifier") {
            usage[pkg].add(property.key.name);
            if (property.value.type === "Identifier") {
              bindings.set(property.value.name, { pkg, name: property.key.name });
            }
          }
        }
      } else if (node.id.type === "Identifier") {
        usage[pkg].add("default");
        bindings.set(node.id.name, { pkg, name: null });
      }
    }
  });

  // Resolves the "object" side of a member expression to a tracked package,
  // one level deep — covers both plain bindings (`axios.get()`) and calling
  // a default export as a factory before chaining (`moment().format()`,
  // a very common pattern for date/query-builder style libraries).
  function resolveCallTargetPackage(expr) {
    if (expr.type === "Identifier") {
      if (bindings.has(expr.name)) {
        return bindings.get(expr.name).pkg;
      }

      // No local import/require binding shadows this name — fall back to
      // an explicit known global (e.g. `React` from a <script> tag), but
      // only when that package is actually declared as a dependency.
      const globalPkg = GLOBAL_NAME_TO_PACKAGE.get(expr.name);
      return globalPkg && dependencies.has(globalPkg) ? globalPkg : null;
    }

    if (expr.type === "CallExpression") {
      if (isRequireCall(expr) || isDynamicImportCall(expr)) {
        return resolveTrackedPackage(expr.arguments[0]?.value, dependencies);
      }
      if (expr.callee.type === "Identifier" && bindings.has(expr.callee.name)) {
        return bindings.get(expr.callee.name).pkg;
      }
    }

    return null;
  }

  // Pass 2: look for evidence of *what's actually used* — member access on
  // a known binding or global (`React.createElement`, `_.debounce`,
  // `axios.get`), the same pattern chained inline off a require()/import()
  // with no intermediate variable, calling a default export before
  // chaining (`moment().format()`), and JSX itself as evidence of React
  // usage. Deliberately matches MemberExpression itself, not just ones
  // used as a call's callee — `const h = React.createElement;` is real
  // evidence even though `createElement` is never actually invoked there.
  walkAst(ast.program, (node) => {
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
      const pkg = resolveCallTargetPackage(node.object);

      if (pkg) {
        usage[pkg].add(node.property.name);
      }
      return;
    }

    if ((node.type === "JSXElement" || node.type === "JSXFragment") && usage.react) {
      // JSX is evidence of React usage even with no explicit `import React`
      // (the modern automatic JSX runtime) — but it's not a specific named
      // export, so it's tracked as its own honest marker, not invented API.
      usage.react.add("JSX");
    }
  });
}

async function analyzeUsage(projectPath, dependencies, excludedDirs = new Set()) {
  const files = getJavaScriptFiles(projectPath, excludedDirs);
  const usage = {};

  for (const dependency of dependencies) {
    usage[dependency] = new Set();
  }

  for (let i = 0; i < files.length; i++) {
    const code = fs.readFileSync(files[i], "utf-8");

    try {
      analyzeFile(code, dependencies, usage);
    } catch (error) {
      // Unparsable file (syntax error, unsupported syntax) — skip it and
      // keep going rather than losing the rest of the project's evidence.
      continue;
    }

    // Yield periodically so the status animation actually gets a chance
    // to redraw while a big project is still being scanned.
    if (i % 15 === 0) {
      await sleep(0);
    }
  }

  return usage;
}

// --- Recommendation engine ---
//
// Snooply produces exactly two kinds of finding, both meant to be
// immediately actionable — everything else is silently NO_FINDING:
//
//   UNUSED             the dependency has zero detected source usage
//   KNOWN_ALTERNATIVE  usage is narrow AND a concrete, curated alternative
//                      is known for exactly that usage
//
// There is deliberately no "few functions used" heuristic on its own.
// Calling one or two APIs out of a library that exposes hundreds is normal,
// not suspicious — it's evidence about *how* something is used, never
// evidence that it's unnecessary. A recommendation only exists when Snooply
// can answer all three of: what did it find, why does it matter, what can
// the developer actually do about it.

const FEW_FUNCTIONS_LIMIT = 2;

// Packages whose architectural role can't be judged by API count — a
// framework/build-tool dependency is never flagged just because only a
// couple of its APIs turned up in a scan.
const FRAMEWORK_PACKAGES = new Set([
  "react",
  "react-dom",
  "react-router-dom",
  "vite",
  "webpack",
  "babel",
  "typescript",
  "eslint",
  "next",
  "vue",
  "@vue/runtime-core",
  "angular",
  "@angular/core",
  "svelte",
  "express",
  "fastify",
  "nestjs",
  "electron",
]);
const FRAMEWORK_PACKAGE_PREFIXES = ["@babel/", "eslint-plugin-", "eslint-config-", "@typescript-eslint/"];

function isFrameworkPackage(name) {
  return FRAMEWORK_PACKAGES.has(name) || FRAMEWORK_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function formatList(names) {
  return names.map((n) => `\`${n}\``).join(" and ");
}

function formatBacktickList(items) {
  return joinWithAnd(items.map((item) => `\`${item}\``));
}

function joinWithAnd(items) {
  if (items.length === 1) {
    return items[0];
  }

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// --- Curated alternative knowledge base ---
//
// Deliberately tiny and explicit. If a dependency/usage pattern isn't
// listed here, there is no recommendation — Snooply never invents one.

// Per-function: "if the entire narrow usage is covered by this map, here's
// a smaller single-purpose replacement for exactly that."
const FUNCTION_ALTERNATIVES = {
  lodash: {
    debounce: "just-debounce-it",
    throttle: "just-throttle",
  },
};

// Whole-package migrations (e.g. moment → date-fns) are intentionally left
// out of the MVP knowledge base for now — the API shapes are different
// enough (chainable/mutable vs. functional/immutable) that "replace X with
// Y" risks overstating how simple the swap actually is. Only add one back
// once there's a specific, defensible case for it.

function findKnownAlternative(dependency, namedUsage) {
  const known = FUNCTION_ALTERNATIVES[dependency];
  if (!known || namedUsage.length === 0) {
    return null;
  }

  const packages = [];
  for (const fn of namedUsage) {
    if (!known[fn]) {
      return null;
    }
    if (!packages.includes(known[fn])) {
      packages.push(known[fn]);
    }
  }

  return { packages };
}

function evaluateDependency(name, used, isDevDependency) {
  const namedUsage = [...used].filter((marker) => !NON_SPECIFIC_MARKERS.has(marker));

  if (used.size === 0) {
    if (isDevDependency) {
      // Normal for build/lint/test tooling — not worth surfacing.
      return { status: "NO_FINDING" };
    }

    return {
      status: "UNUSED",
      reason: `Snooply couldn't find \`${name}\` used anywhere in your source files.`,
      suggestion: "If you no longer need it, you can remove it.",
    };
  }

  if (isFrameworkPackage(name)) {
    return { status: "NO_FINDING" };
  }

  if (namedUsage.length === 0) {
    // Only whole-module evidence (default/namespace import, or JSX with no
    // specific attribution) — too thin to say anything concrete, so Snooply
    // stays quiet rather than guessing.
    return { status: "NO_FINDING" };
  }

  if (namedUsage.length > FEW_FUNCTIONS_LIMIT) {
    // Broad, varied usage of a broad library — using many of its
    // capabilities is exactly what it's there for.
    return { status: "NO_FINDING" };
  }

  if (isDevDependency) {
    // The "smaller runtime footprint" motivation behind these alternatives
    // doesn't apply to devDependencies — they aren't shipped, so there's
    // nothing concrete to recommend even with narrow usage.
    return { status: "NO_FINDING" };
  }

  const alternative = findKnownAlternative(name, namedUsage);
  if (!alternative) {
    // Narrow usage alone is never a recommendation on its own — only flag
    // it when there's a concrete, curated alternative to point at.
    return { status: "NO_FINDING" };
  }

  return {
    status: "KNOWN_ALTERNATIVE",
    used: namedUsage,
    reason: `You're only using ${formatList(namedUsage)} from \`${name}\`.`,
    suggestion: `If ${formatList(namedUsage)} ${namedUsage.length === 1 ? "is" : "are"} all you need, consider ${formatBacktickList(alternative.packages)} instead.`,
    suggestedPackages: alternative.packages,
  };
}

// Turns a raw usage Set (which may contain internal markers like "default"
// or "JSX" alongside real export names) into what the CLI should actually
// print — never the raw sentinels themselves.
function formatUsageForDisplay(used) {
  const named = [...used].filter((name) => !NON_SPECIFIC_MARKERS.has(name));
  const labels = [...named];

  if (used.has("JSX")) {
    labels.push("JSX usage");
  }

  if (labels.length === 0 && (used.has("default") || used.has("*"))) {
    labels.push("default import usage");
  }

  return labels.length > 0 ? labels.join(", ") : null;
}

function buildResults(usage, devDependencyNames) {
  const recommendations = [];
  const unused = [];

  for (const [dependency, used] of Object.entries(usage)) {
    const result = evaluateDependency(dependency, used, devDependencyNames.has(dependency));

    if (result.status === "KNOWN_ALTERNATIVE") {
      recommendations.push({
        dependency,
        used: result.used,
        reason: result.reason,
        suggestion: result.suggestion,
        suggestedPackages: result.suggestedPackages,
        hasAlternative: true,
      });
    } else if (result.status === "UNUSED") {
      unused.push({
        dependency,
        used: [],
        reason: result.reason,
        suggestion: result.suggestion,
        suggestedPackages: [],
        hasAlternative: false,
      });
    }
  }

  return { recommendations, unused };
}

// --- Popup UI ---
//
// A small React app renders the structured data already produced by the
// recommendation and suggestion engines above — it never recomputes a
// verdict or a suggestion itself, it only displays what it's given. It's
// served from a tiny local HTTP server (Node's built-in `http`, no
// framework) and opened as a compact app-style window. The server shuts
// itself down as soon as the page is closed, so nothing lingers in the
// background — see the heartbeat/close handling below.

const UI_DIR = path.join(__dirname, "ui");
const NODE_MODULES_DIR = path.join(__dirname, "..", "node_modules");

function readUiFile(...segments) {
  return fs.readFileSync(path.join(...segments), "utf-8");
}

// The page itself is just this shell — all real markup comes from React
// (app.jsx) and all styling from app.css, so there's no separate HTML file
// to keep in sync.
function buildHtmlDocument(payload) {
  const dataJson = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Snooply</title>
<link rel="stylesheet" href="/app.css" />
</head>
<body>
  <div id="root"></div>
  <script id="snooply-data" type="application/json">${dataJson}</script>
  <script src="/react.js"></script>
  <script src="/react-dom.js"></script>
  <script src="/app.jsx"></script>
</body>
</html>`;
}

function resolveElectronBinary() {
  try {
    // Required from a plain Node process (not from inside Electron itself),
    // the `electron` package's main export is the path to its binary.
    const electronPath = require("electron");
    if (typeof electronPath === "string" && fs.existsSync(electronPath)) {
      return electronPath;
    }
  } catch (error) {
    // Not installed / failed to resolve — fall back below.
  }
  return null;
}

function openPopupWindowInBrowser(url) {
  if (process.platform === "darwin") {
    const appModeCandidates = [
      "/Applications/Google Chrome.app",
      "/Applications/Microsoft Edge.app",
      "/Applications/Brave Browser.app",
      "/Applications/Chromium.app",
    ];

    for (const appPath of appModeCandidates) {
      if (fs.existsSync(appPath)) {
        spawn("open", ["-na", appPath, "--args", `--app=${url}`, "--window-size=420,620"], {
          stdio: "ignore",
          detached: true,
        }).unref();
        return;
      }
    }

    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }

  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true, shell: true }).unref();
    return;
  }

  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

function openPopupWindow(url) {
  const electronBinary = resolveElectronBinary();

  if (electronBinary) {
    // A real transparent, frameless, always-on-top overlay window — this is
    // what makes it feel like a notification over the editor rather than a
    // separate application. If the parent shell has ELECTRON_RUN_AS_NODE set
    // (common when Snooply itself is launched from inside an Electron-based
    // tool, e.g. a VS Code terminal), it leaks into this child and forces
    // Electron to run as plain Node instead of a real app — strip it.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    spawn(electronBinary, [path.join(__dirname, "electron-main.js"), url], {
      stdio: "ignore",
      detached: true,
      env,
    }).unref();
    return;
  }

  // Electron unavailable for some reason — degrade to a plain app-style
  // browser window rather than failing outright.
  openPopupWindowInBrowser(url);
}

function showReactPopup(flaggedItems, dependencies, usage) {
  return new Promise((resolve) => {
    const payload = {
      items: flaggedItems,
      dependencies: [...dependencies],
      usage: Object.fromEntries([...dependencies].map((dep) => [dep, [...(usage[dep] || [])]])),
    };

    let firstPingReceived = false;
    let lastPingAt = Date.now();
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(heartbeatCheck);
      clearTimeout(launchTimeout);
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      server.close();
      resolve();
    };

    const server = http.createServer((req, res) => {
      const url = req.url.split("?")[0];

      try {
        if (url === "/") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(buildHtmlDocument(payload));
        } else if (url === "/app.jsx") {
          res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
          res.end(readUiFile(UI_DIR, "app.jsx"));
        } else if (url === "/app.css") {
          res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
          res.end(readUiFile(UI_DIR, "app.css"));
        } else if (url === "/react.js") {
          res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
          res.end(readUiFile(NODE_MODULES_DIR, "react", "umd", "react.production.min.js"));
        } else if (url === "/react-dom.js") {
          res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
          res.end(readUiFile(NODE_MODULES_DIR, "react-dom", "umd", "react-dom.production.min.js"));
        } else if (url === "/ping") {
          firstPingReceived = true;
          lastPingAt = Date.now();
          res.writeHead(204);
          res.end();
        } else if (url === "/close") {
          res.writeHead(204);
          res.end();
          finish();
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (error) {
        res.writeHead(500);
        res.end();
      }
    });

    // Once the page has loaded and started pinging, a missed heartbeat means
    // the window was closed (directly, not via our Close button) — shut down.
    const heartbeatCheck = setInterval(() => {
      if (firstPingReceived && Date.now() - lastPingAt > 5000) {
        finish();
      }
    }, 1000);

    // Safety net in case the window never opens/loads at all.
    const launchTimeout = setTimeout(() => {
      if (!firstPingReceived) {
        finish();
      }
    }, 30000);

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      openPopupWindow(`http://127.0.0.1:${port}/`);
    });

    server.on("error", () => finish());
  });
}

async function main() {
  const projectPath = process.cwd();
  const verbose = process.argv.includes("--verbose");

  const workspaceRoots = findWorkspaceRoots(projectPath);

  if (workspaceRoots.length === 0) {
    console.log("🐾 Snooply couldn't find a package.json here.");
    process.exitCode = 1;
    return;
  }

  // A plain single-package project (the common case, and everything Snooply
  // supported before this) must keep behaving exactly as it did — including
  // this exact error message when that one package.json is malformed.
  if (workspaceRoots.length === 1) {
    try {
      JSON.parse(fs.readFileSync(path.join(workspaceRoots[0], "package.json"), "utf-8"));
    } catch (error) {
      console.log("🐾 Snooply found a package.json here, but couldn't read it (invalid JSON).");
      process.exitCode = 1;
      return;
    }
  }

  const stopStatusAnimation = startStatusAnimation(STATUS_MESSAGES);

  const workspaces = [];

  for (const root of workspaceRoots) {
    let packageJson;
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    } catch (error) {
      // Malformed package.json in one workspace of a multi-package project
      // shouldn't take down the scan for every other workspace.
      continue;
    }

    const devDependencyNames = new Set(Object.keys(packageJson.devDependencies || {}));
    const dependencies = new Set([
      ...Object.keys(packageJson.dependencies || {}),
      ...devDependencyNames,
    ]);

    // Other discovered workspaces nested inside this one are scanned on
    // their own — never as part of this package's source tree, so a
    // dependency in one package can't get credited with usage that
    // actually lives in another.
    const excludedDirs = new Set(
      workspaceRoots.filter((other) => other !== root && other.startsWith(root + path.sep))
    );

    const usage = await analyzeUsage(root, dependencies, excludedDirs);
    const { recommendations, unused } = buildResults(usage, devDependencyNames);

    workspaces.push({
      label: getWorkspaceLabel(root, projectPath),
      dependencies,
      usage,
      recommendations,
      unused,
    });
  }

  stopStatusAnimation();

  const showWorkspaceLabels = workspaces.length > 1;

  // The analyzer always computes full evidence per workspace (see
  // analyzeUsage/buildResults above) — this is just the presentation choice
  // for the normal `snooply` run. --verbose prints the same detailed
  // breakdown the CLI always used to show, per workspace; without it, the
  // terminal only gets the final, user-facing result and the React popup
  // carries the detailed experience.
  if (verbose) {
    for (const ws of workspaces) {
      if (showWorkspaceLabels) {
        console.log(ws.label.toUpperCase() + "\n");
      }

      console.log("Snooply found your dependencies:\n");

      for (const dependency of ws.dependencies) {
        console.log(`• ${dependency}`);
      }

      console.log("\nSnooply found usage:\n");

      for (const [dependency, used] of Object.entries(ws.usage)) {
        const display = formatUsageForDisplay(used);
        console.log(`• ${dependency}: ${display || "not detected"}`);
      }

      console.log("\n" + "=".repeat(40) + "\n");
    }
  }

  const flaggedItems = [];
  for (const ws of workspaces) {
    flaggedItems.push(
      ...ws.recommendations.map((item) => ({ ...item, kind: "WORTH_LOOKING_AT", workspace: ws.label })),
      ...ws.unused.map((item) => ({ ...item, kind: "UNUSED", workspace: ws.label }))
    );
  }

  if (flaggedItems.length === 0) {
    console.log("🐾 Snooply took a little look...");
    console.log("Everything looks pretty reasonable! ♡");
  } else {
    const noun = flaggedItems.length === 1 ? "thing" : "things";
    console.log(`🐾 Snooply found ${flaggedItems.length} ${noun} worth checking.\n`);

    let currentLabel = null;

    for (const item of flaggedItems) {
      if (showWorkspaceLabels && item.workspace !== currentLabel) {
        currentLabel = item.workspace;
        console.log(currentLabel.toUpperCase());
      }

      console.log(`• ${item.dependency}`);
      console.log(`  ${item.reason}`);
      console.log(`  ${item.suggestion}`);
      console.log("");
    }
  }

  // The popup UI (app.jsx, untouched) only understands one flat dependency
  // list/usage map — when there's more than one workspace, dependency names
  // are suffixed with their workspace so cards and the "see all
  // dependencies" view can't collide or look cross-attributed, without
  // requiring any change to the popup itself.
  const popupItems = showWorkspaceLabels
    ? flaggedItems.map((item) => ({ ...item, dependency: `${item.dependency} (${item.workspace})` }))
    : flaggedItems;

  const popupDependencies = new Set();
  const popupUsage = {};

  for (const ws of workspaces) {
    for (const dependency of ws.dependencies) {
      const key = showWorkspaceLabels ? `${dependency} (${ws.label})` : dependency;
      popupDependencies.add(key);
      popupUsage[key] = ws.usage[dependency];
    }
  }

  await showReactPopup(popupItems, popupDependencies, popupUsage);
}

main().catch(() => {
  console.log("🐾 Snooply hit a snag and had to stop.");
  process.exitCode = 1;
});