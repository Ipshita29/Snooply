#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const http = require("http");
const { spawn } = require("child_process");
const parser = require("@babel/parser");

// --- Loading animation ---
// Rotates a single line of status text while Snooply works.
// No fake percentages, just a sign that something's happening.

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

// --- Project scanning ---

// Find source files in a folder
// (excludedDirs skips other workspaces nested inside this one)
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

// Find every package.json in the project
// (covers single packages, apps/*, packages/*, or any other layout)
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

// Short label for a workspace, like "client" or "apps/web"
function getWorkspaceLabel(root, projectPath) {
  const relative = path.relative(projectPath, root);
  return relative === "" ? "root" : relative.split(path.sep).join("/");
}

// Markers for "used, but no specific function name"
const NON_SPECIFIC_MARKERS = new Set(["default", "*", "JSX"]);

// --- Dependency analyzer ---

// Walk every node in the AST
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

// Known globals for packages loaded via <script> tags
// (e.g. Snooply's own UI uses window.React, no import statement)
const GLOBAL_PACKAGE_BINDINGS = {
  react: ["React"],
  "react-dom": ["ReactDOM"],
  // react-router-dom's UMD build uses this name
  "react-router-dom": ["ReactRouterDOM"],
};

const GLOBAL_NAME_TO_PACKAGE = new Map();
for (const [pkg, globalNames] of Object.entries(GLOBAL_PACKAGE_BINDINGS)) {
  for (const globalName of globalNames) {
    GLOBAL_NAME_TO_PACKAGE.set(globalName, pkg);
  }
}

// Match an import path to a known package
// (handles subpaths like "react-dom/client" or "@scope/pkg/sub")
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

// Parse a file and find package usage
function analyzeFile(code, dependencies, usage) {
  const ast = parser.parse(code, {
    sourceType: "unambiguous",
    plugins: ["jsx"],
  });

  // Track which local name maps to which package
  // (e.g. `debounce` -> lodash, so `debounce()` counts as usage)
  const bindings = new Map();

  // Find imports and requires
  walkAst(ast.program, (node) => {
    if (node.type === "ImportDeclaration") {
      const source = node.source.value;
      const pkg = resolveTrackedPackage(source, dependencies);
      if (!pkg) {
        return;
      }

      if (node.specifiers.length === 0) {
        // Side-effect import, e.g. `import "some-polyfill"`
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

  // Match `axios.get()` or `moment().format()` back to a package
  function resolveCallTargetPackage(expr) {
    if (expr.type === "Identifier") {
      if (bindings.has(expr.name)) {
        return bindings.get(expr.name).pkg;
      }

      // Not a local binding - check known globals instead
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

  // Find package usage
  // (member access like `React.createElement`, plus JSX as React usage)
  walkAst(ast.program, (node) => {
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
      const pkg = resolveCallTargetPackage(node.object);

      if (pkg) {
        usage[pkg].add(node.property.name);
      }
      return;
    }

    if ((node.type === "JSXElement" || node.type === "JSXFragment") && usage.react) {
      // JSX counts as React usage even without `import React`
      usage.react.add("JSX");
    }
  });

}

// Scan all source files and collect usage
async function analyzeUsage(projectPath, dependencies, excludedDirs = new Set()) {
  const files = getJavaScriptFiles(projectPath, excludedDirs);
  const usage = {};
  // Which files use each dependency, and what was found in each one
  // (feeds the "where it was found" detail view)
  const usageByFile = {};
  // Files that failed to parse - only surfaced in --verbose
  const skippedFiles = [];

  for (const dependency of dependencies) {
    usage[dependency] = new Set();
    usageByFile[dependency] = [];
  }

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const code = fs.readFileSync(filePath, "utf-8");

    const fileUsage = {};
    for (const dependency of dependencies) {
      fileUsage[dependency] = new Set();
    }

    try {
      analyzeFile(code, dependencies, fileUsage);
    } catch (error) {
      // Skip files that fail to parse
      skippedFiles.push(filePath);
      continue;
    }

    for (const dependency of dependencies) {
      for (const evidence of fileUsage[dependency]) {
        usage[dependency].add(evidence);
      }
      if (fileUsage[dependency].size > 0) {
        usageByFile[dependency].push({ file: filePath, used: [...fileUsage[dependency]] });
      }
    }

    // Let the loading animation redraw on big projects
    if (i % 15 === 0) {
      await sleep(0);
    }
  }

  return { usage, usageByFile, files, skippedFiles };
}

// --- Recommendation engine ---
//
// Only two kinds of finding: UNUSED (no usage found) and
// KNOWN_ALTERNATIVE (narrow usage + a known smaller replacement).
// Using a couple of functions from a big library is normal, not
// suspicious, so that alone is never a reason to flag something.

const FEW_FUNCTIONS_LIMIT = 2;

// Frameworks aren't flagged just for light usage
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

// --- Known alternatives ---
// Small and explicit on purpose. No match here means no
// recommendation - Snooply never makes one up.
const FUNCTION_ALTERNATIVES = {
  lodash: {
    debounce: "just-debounce-it",
    throttle: "just-throttle",
  },
};
// No moment -> date-fns entry yet: the APIs are too
// different for that to be a safe drop-in suggestion

// Find a known smaller alternative
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

// Decide if a dependency is worth flagging
function evaluateDependency(name, used, isDevDependency) {
  const namedUsage = [...used].filter((marker) => !NON_SPECIFIC_MARKERS.has(marker));

  if (used.size === 0) {
    if (isDevDependency) {
      // Normal for build/lint/test tooling
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
    // Just a default/namespace import, too vague to say anything useful
    return { status: "NO_FINDING" };
  }

  if (namedUsage.length > FEW_FUNCTIONS_LIMIT) {
    // Using lots of the library is normal, not a red flag
    return { status: "NO_FINDING" };
  }

  if (isDevDependency) {
    // Bundle size doesn't matter for devDependencies
    return { status: "NO_FINDING" };
  }

  const alternative = findKnownAlternative(name, namedUsage);
  if (!alternative) {
    // Light usage alone isn't a recommendation without a real alternative
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

// Turn raw usage into readable text (used by the CLI, and by the
// popup's per-file "where it was found" evidence)
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

// Create dependency recommendations
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

// --- Verbose CLI output ---
// Displays the same analysis the popup uses, just in more detail.
// No extra analysis happens here - it only prints existing data.

// Print how much each dependency was used, and where
function printDependencyUsage(dependencies, usageByFile, root) {
  console.log("DEPENDENCY USAGE");
  console.log("-".repeat(24) + "\n");

  for (const dependency of dependencies) {
    const files = usageByFile[dependency] || [];
    console.log(dependency);
    console.log(`  ${files.length} file${files.length === 1 ? "" : "s"}`);

    files.forEach((entry, i) => {
      const branch = i === files.length - 1 ? "└─" : "├─";
      console.log(`  ${branch} ${path.relative(root, entry.file)}`);
    });

    console.log("");
  }
}

// Print what the recommendation engine flagged
function printRecommendations(recommendations, unused) {
  console.log("RECOMMENDATIONS");
  console.log("-".repeat(24) + "\n");

  if (recommendations.length === 0 && unused.length === 0) {
    console.log("Nothing flagged.\n");
    return;
  }

  for (const item of unused) {
    console.log(item.dependency);
    console.log("  → unused\n");
  }

  for (const item of recommendations) {
    console.log(item.dependency);
    console.log("  → known alternative");
    if (item.suggestedPackages.length > 0) {
      console.log(`  → ${item.used.join(", ")} → ${item.suggestedPackages.join(", ")}`);
    }
    console.log("");
  }
}

// Print files that couldn't be parsed, if any
function printSkippedFiles(skippedFiles, root) {
  if (skippedFiles.length === 0) {
    return;
  }

  console.log("Could not parse:");
  for (const file of skippedFiles) {
    console.log(`  ${path.relative(root, file)}`);
  }
  console.log("");
}

// --- Popup server ---
//
// Serves the React UI over a local HTTP server and opens it in the
// Snooply window. The UI just displays this data, it doesn't recompute
// anything. Server shuts down once the popup is closed.

const UI_DIR = path.join(__dirname, "ui");
const NODE_MODULES_DIR = path.join(__dirname, "..", "node_modules");

function readUiFile(...segments) {
  return fs.readFileSync(path.join(...segments), "utf-8");
}

// Build the popup's HTML page
// (real content comes from app.jsx and app.css, this is just the shell)
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

// Find the electron binary, if installed
function resolveElectronBinary() {
  try {
    const electronPath = require("electron");
    if (typeof electronPath === "string" && fs.existsSync(electronPath)) {
      return electronPath;
    }
  } catch (error) {
    // Not installed - fall back below
  }
  return null;
}

// Fallback: open the popup as a browser tab instead
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

// Show the Snooply window
function openPopupWindow(url) {
  const electronBinary = resolveElectronBinary();

  if (electronBinary) {
    // Strip ELECTRON_RUN_AS_NODE - it can leak in from a parent
    // Electron process (like a VS Code terminal) and break the launch
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    spawn(electronBinary, [path.join(__dirname, "window.js"), url], {
      stdio: "ignore",
      detached: true,
      env,
    }).unref();
    return;
  }

  // No Electron - fall back to a browser tab
  openPopupWindowInBrowser(url);
}

// Start the local server and open the popup
// `verboseInfo` is only set for `snooply --verbose` - it carries the same
// analysis result, just reshaped for the popup's deeper view.
function showReactPopup(flaggedItems, dependencies, usage, verboseInfo) {
  return new Promise((resolve) => {
    const payload = {
      items: flaggedItems,
      dependencies: [...dependencies],
      usage: Object.fromEntries([...dependencies].map((dep) => [dep, [...(usage[dep] || [])]])),
      version: require("../package.json").version,
      verbose: Boolean(verboseInfo),
      project: verboseInfo ? verboseInfo.project : null,
      packages: verboseInfo ? verboseInfo.packages : [],
      dependencyUsage: verboseInfo ? verboseInfo.dependencyUsage : [],
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

    // A missed heartbeat means the window was closed
    const heartbeatCheck = setInterval(() => {
      if (firstPingReceived && Date.now() - lastPingAt > 5000) {
        finish();
      }
    }, 1000);

    // In case the window never opens at all
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

// --- CLI entry point ---
async function main() {
  const projectPath = process.cwd();
  const verbose = process.argv.includes("--verbose");

  // Find project files
  const workspaceRoots = findWorkspaceRoots(projectPath);

  if (workspaceRoots.length === 0) {
    console.log("🐾 Snooply couldn't find a package.json here.");
    process.exitCode = 1;
    return;
  }

  // Keep the single-package error message exactly as before
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
    // Read the package manifest
    let packageJson;
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    } catch (error) {
      // Skip this workspace, don't stop the whole scan
      continue;
    }

    const devDependencyNames = new Set(Object.keys(packageJson.devDependencies || {}));
    const dependencies = new Set([
      ...Object.keys(packageJson.dependencies || {}),
      ...devDependencyNames,
    ]);

    // Don't scan into other workspaces nested in this one
    const excludedDirs = new Set(
      workspaceRoots.filter((other) => other !== root && other.startsWith(root + path.sep))
    );

    // Find package usage
    const { usage, usageByFile, files, skippedFiles } = await analyzeUsage(root, dependencies, excludedDirs);
    const { recommendations, unused } = buildResults(usage, devDependencyNames);

    workspaces.push({
      label: getWorkspaceLabel(root, projectPath),
      root,
      dependencies,
      usage,
      usageByFile,
      files,
      skippedFiles,
      recommendations,
      unused,
    });
  }

  stopStatusAnimation();

  const showWorkspaceLabels = workspaces.length > 1;

  // Detailed breakdown, only shown with --verbose
  // (normal output stays clean, the popup shows the details)
  if (verbose) {
    console.log("🐾 Snooply is snooping around...\n");

    console.log("PROJECT");
    console.log(path.basename(projectPath) + "/\n");

    if (workspaces.length === 0) {
      console.log("No readable package.json found.\n");
    } else if (workspaces.length === 1) {
      const ws = workspaces[0];
      console.log("DEPENDENCIES");
      console.log(`${ws.dependencies.size}\n`);
      console.log("SOURCE FILES");
      console.log(`${ws.files.length}\n`);

      printDependencyUsage(ws.dependencies, ws.usageByFile, ws.root);
      printRecommendations(ws.recommendations, ws.unused);
      printSkippedFiles(ws.skippedFiles, ws.root);
    } else {
      console.log("PACKAGES");
      console.log("-".repeat(24) + "\n");

      for (const ws of workspaces) {
        console.log(`${ws.label}/`);
        console.log(`  dependencies: ${ws.dependencies.size}`);
        console.log(`  source files: ${ws.files.length}\n`);
      }

      for (const ws of workspaces) {
        console.log(ws.label.toUpperCase() + "\n");
        printDependencyUsage(ws.dependencies, ws.usageByFile, ws.root);
        printRecommendations(ws.recommendations, ws.unused);
        printSkippedFiles(ws.skippedFiles, ws.root);
      }
    }

    console.log("-".repeat(40) + "\n");
  }

  const flaggedItems = [];
  for (const ws of workspaces) {
    // Attach real, already-known evidence for the detail view -
    // which files it showed up in, and what was checked. Nothing here
    // is invented; it's just the analyzer's own data, reshaped.
    const withEvidence = (item, kind) => {
      const fileEntries = ws.usageByFile[item.dependency] || [];
      return {
        ...item,
        kind,
        workspace: ws.label,
        where: fileEntries.map((entry) => ({
          file: path.relative(ws.root, entry.file),
          used: formatUsageForDisplay(new Set(entry.used)),
        })),
        filesChecked: ws.files.length,
        dependenciesChecked: ws.dependencies.size,
        dependenciesList: [...ws.dependencies],
      };
    };

    flaggedItems.push(
      ...ws.recommendations.map((item) => withEvidence(item, "WORTH_LOOKING_AT")),
      ...ws.unused.map((item) => withEvidence(item, "UNUSED"))
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

  // Tag dependency names with their workspace so the popup
  // (which only knows one flat list) can't mix them up
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

  // For --verbose, reshape the same workspace data the CLI printed
  // above into something the popup can render. No re-analysis.
  const verboseInfo = verbose
    ? {
        project: path.basename(projectPath),
        packages: workspaces.map((ws) => ({
          label: ws.label,
          dependencies: ws.dependencies.size,
          files: ws.files.length,
        })),
        dependencyUsage: workspaces.flatMap((ws) =>
          [...ws.dependencies].map((dependency) => ({
            dependency: showWorkspaceLabels ? `${dependency} (${ws.label})` : dependency,
            files: (ws.usageByFile[dependency] || []).map((entry) => path.relative(ws.root, entry.file)),
          }))
        ),
      }
    : null;

  // Show the Snooply window
  await showReactPopup(popupItems, popupDependencies, popupUsage, verboseInfo);
}

main().catch(() => {
  console.log("🐾 Snooply hit a snag and had to stop.");
  process.exitCode = 1;
});