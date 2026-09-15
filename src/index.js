#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const http = require("http");
const { spawn } = require("child_process");

const { findWorkspaceRoots, getWorkspaceLabel } = require("./core/project");
const { readManifest, uninstallCommandFor, installCommandFor } = require("./core/package-managers");
const { analyzeWorkspace } = require("./core/analyzer");
const { buildResults, formatUsageForDisplay } = require("./core/recommendations");

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

// --- Verbose CLI output ---
// Displays the same analysis the popup uses, just in more detail.
// No extra analysis happens here - it only prints existing data.

const SECTION_DIVIDER = "-".repeat(24);

// Print how much each dependency was used, and where
function printDependencyUsage(dependencies, usageByFile, root) {
  console.log("DEPENDENCY USAGE");
  console.log(SECTION_DIVIDER + "\n");

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
  console.log(SECTION_DIVIDER + "\n");

  if (recommendations.length === 0 && unused.length === 0) {
    console.log("Nothing flagged.\n");
    return;
  }

  // Same order as normal mode: known alternatives, then unused
  for (const item of recommendations) {
    console.log(item.dependency);
    console.log("  → known alternative");
    if (item.suggestedPackages.length > 0) {
      console.log(`  → ${item.used.join(", ")} → ${item.suggestedPackages.join(", ")}`);
    }
    console.log("");
  }

  for (const item of unused) {
    console.log(item.dependency);
    console.log("  → unused\n");
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
    console.log("🐾 Snooply couldn't find a package.json, requirements.txt, or pyproject.toml here.");
    process.exitCode = 1;
    return;
  }

  // Keep the single-package error message exactly as before
  if (workspaceRoots.length === 1) {
    try {
      readManifest(workspaceRoots[0]);
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
    let manifest;
    try {
      manifest = readManifest(root);
    } catch (error) {
      // Skip this workspace, don't stop the whole scan
      continue;
    }

    const { dependencies, devDependencyNames, packageManagers } = manifest;

    // Don't scan into other workspaces nested in this one
    const excludedDirs = new Set(
      workspaceRoots.filter((other) => other !== root && other.startsWith(root + path.sep))
    );

    // Select and run the right language analyzer(s) for this workspace
    const { usage, usageByFile, files, skippedFiles } = await analyzeWorkspace(root, dependencies, excludedDirs);
    const { recommendations, unused } = buildResults(usage, devDependencyNames);

    workspaces.push({
      label: getWorkspaceLabel(root, projectPath),
      root,
      dependencies,
      packageManagers,
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
      console.log(SECTION_DIVIDER + "\n");

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
      // Real package manager for this dependency (npm, pip, ...) - used
      // to build a real uninstall/install command, not a guessed one
      const packageManager = ws.packageManagers[item.dependency] || "npm";

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
        packageManager,
        uninstallCommand: uninstallCommandFor(packageManager, item.dependency),
        installCommand: item.suggestedPackages.length > 0
          ? installCommandFor(packageManager, item.suggestedPackages)
          : null,
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