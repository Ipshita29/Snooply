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

function getJavaScriptFiles(directory) {
  const files = [];

  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    return files;
  }

  for (const item of entries) {
    if (
      item === "node_modules" ||
      item === ".git" ||
      item === "dist" ||
      item === "build"
    ) {
      continue;
    }

    const fullPath = path.join(directory, item);

    let stats;
    try {
      stats = fs.statSync(fullPath);
    } catch (error) {
      continue;
    }

    if (stats.isDirectory()) {
      files.push(...getJavaScriptFiles(fullPath));
    } else if (
      item.endsWith(".js") ||
      item.endsWith(".jsx")
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

async function analyzeUsage(projectPath, dependencies) {
  const files = getJavaScriptFiles(projectPath);
  const usage = {};

  for (const dependency of dependencies) {
    usage[dependency] = new Set();
  }

  for (let i = 0; i < files.length; i++) {
    const code = fs.readFileSync(files[i], "utf-8");

    let ast;

    try {
      ast = parser.parse(code, {
        sourceType: "unambiguous",
        plugins: ["jsx"],
      });
    } catch (error) {
      continue;
    }

    for (const node of ast.program.body) {

      // ES module imports
      if (node.type === "ImportDeclaration") {
        const packageName = node.source.value;

        if (!dependencies.has(packageName)) {
          continue;
        }

        if (node.specifiers.length === 0) {
          // Side-effect-only import, e.g. `import "some-polyfill";` —
          // it's real usage, we just can't attribute it to a named export.
          usage[packageName].add("default");
        }

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            usage[packageName].add(specifier.imported.name);
          }

          if (specifier.type === "ImportDefaultSpecifier") {
            usage[packageName].add("default");
          }

          if (specifier.type === "ImportNamespaceSpecifier") {
            usage[packageName].add("*");
          }
        }
      }

      // CommonJS require
      if (node.type === "VariableDeclaration") {
        for (const declaration of node.declarations) {
          if (declaration.init?.type !== "CallExpression") {
            continue;
          }

          if (declaration.init.callee.name !== "require") {
            continue;
          }

          const packageName = declaration.init.arguments[0]?.value;

          if (!packageName || !dependencies.has(packageName)) {
            continue;
          }

          if (declaration.id.type === "ObjectPattern") {
            for (const property of declaration.id.properties) {
              if (property.type === "ObjectProperty") {
                usage[packageName].add(property.key.name);
              }
            }
          } else {
            usage[packageName].add("default");
          }
        }
      }
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
// Turns raw usage evidence into a verdict. Never based on percentages —
// only on how many distinct named imports we actually observed.

const WHOLE_MODULE_MARKERS = new Set(["default", "*"]);
const FEW_FUNCTIONS_LIMIT = 2;

function classifyDependency(name, used, isDevDependency) {
  const namedUsage = [...used].filter(
    (importedName) => !WHOLE_MODULE_MARKERS.has(importedName)
  );
  const importsWholeModule = [...used].some((importedName) =>
    WHOLE_MODULE_MARKERS.has(importedName)
  );

  if (used.size === 0) {
    if (isDevDependency) {
      return {
        status: "NOT_ENOUGH_EVIDENCE",
        reason: `${name} is a devDependency with no detected source imports, which is normal for build/lint/test tooling.`,
      };
    }

    return {
      status: "UNUSED",
      reason: `Snooply didn't find \`${name}\` imported anywhere in your code.`,
    };
  }

  if (namedUsage.length === 0 && importsWholeModule) {
    return {
      status: "NOT_ENOUGH_EVIDENCE",
      reason: `\`${name}\` is only ever imported as a whole module, so Snooply can't tell which parts of it you actually use.`,
    };
  }

  if (namedUsage.length <= FEW_FUNCTIONS_LIMIT) {
    return {
      status: "WORTH_LOOKING_AT",
      used: namedUsage,
      reason: `You're using only ${formatList(namedUsage)} from \`${name}\`.`,
    };
  }

  return {
    status: "DO_NOT_FLAG",
    used: namedUsage,
    reason: `You're using ${namedUsage.length} different exports from \`${name}\` (${namedUsage.join(", ")}).`,
  };
}

function formatList(names) {
  return names.map((n) => `\`${n}\``).join(" and ");
}

// --- Suggestion engine ---
//
// Purely additive: it never influences `status` from the recommendation
// engine above. It only speaks up when we have a confident, curated
// alternative for EVERY named function actually used — if even one used
// function has no known alternative, it stays quiet rather than guessing.
// When it does speak up, it names the actual package — never a vague
// "you might not need this" with nothing concrete behind it.

const KNOWN_ALTERNATIVES = {
  lodash: {
    debounce: "just-debounce-it",
    throttle: "just-throttle",
  },
};

function getSuggestion(dependency, namedUsage) {
  const known = KNOWN_ALTERNATIVES[dependency];

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

  const text = [
    `You're only using ${formatBacktickList(namedUsage)}.`,
    "",
    `Try ${formatBacktickList(packages)} instead.`,
  ].join("\n");

  return { text, packages };
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

function buildResults(usage, devDependencyNames) {
  const recommendations = [];
  const unused = [];

  for (const [dependency, used] of Object.entries(usage)) {
    const result = classifyDependency(
      dependency,
      used,
      devDependencyNames.has(dependency)
    );

    if (result.status === "WORTH_LOOKING_AT") {
      const suggestion = getSuggestion(dependency, result.used);

      recommendations.push({
        dependency,
        used: result.used,
        reason: result.reason,
        // Evidence-based even without a known alternative — never a made-up
        // package name just to have something to say.
        suggestion: suggestion ? suggestion.text : "This dependency might be worth a look.",
        suggestedPackages: suggestion ? suggestion.packages : [],
        hasAlternative: suggestion !== null,
      });
    } else if (result.status === "UNUSED") {
      unused.push({
        dependency,
        used: [],
        reason: result.reason,
        suggestion: null,
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

    spawn(electronBinary, [path.join(UI_DIR, "electron-main.js"), url], {
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
          const html = readUiFile(UI_DIR, "index.html").replace(
            "__SNOOPLY_DATA__",
            JSON.stringify(payload).replace(/</g, "\\u003c")
          );
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } else if (url === "/app.js") {
          res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
          res.end(readUiFile(UI_DIR, "app.js"));
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
  const packageJsonPath = path.join(projectPath, "package.json");

  if (!fs.existsSync(packageJsonPath)) {
    console.log("🐾 Snooply couldn't find a package.json here.");
    process.exitCode = 1;
    return;
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } catch (error) {
    console.log("🐾 Snooply found a package.json here, but couldn't read it (invalid JSON).");
    process.exitCode = 1;
    return;
  }

  const stopStatusAnimation = startStatusAnimation(STATUS_MESSAGES);

  const devDependencyNames = new Set(
    Object.keys(packageJson.devDependencies || {})
  );

  const dependencies = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...devDependencyNames,
  ]);

  const usage = await analyzeUsage(projectPath, dependencies);
  const { recommendations, unused } = buildResults(usage, devDependencyNames);

  stopStatusAnimation();

  console.log("Snooply found your dependencies:\n");

  for (const dependency of dependencies) {
    console.log(`• ${dependency}`);
  }

  console.log("\nSnooply is checking your source files...\n");

  console.log("Snooply found usage:\n");

  for (const [dependency, used] of Object.entries(usage)) {
    if (used.size === 0) {
      console.log(`• ${dependency}: not detected`);
    } else {
      console.log(`• ${dependency}: ${[...used].join(", ")}`);
    }
  }

  console.log("\n" + "=".repeat(40) + "\n");

  const flaggedItems = [
    ...recommendations.map((item) => ({ ...item, kind: "WORTH_LOOKING_AT" })),
    ...unused.map((item) => ({ ...item, kind: "UNUSED" })),
  ];

  if (flaggedItems.length === 0) {
    console.log("🐾 Snooply took a little look...");
    console.log("Everything looks pretty reasonable! ♡");
  } else if (flaggedItems.length === 1) {
    console.log("🐾 Snooply found something!");
  } else {
    console.log(`🐾 Snooply found ${flaggedItems.length} things!`);
  }

  await showReactPopup(flaggedItems, dependencies, usage);
}

main().catch(() => {
  console.log("🐾 Snooply hit a snag and had to stop.");
  process.exitCode = 1;
});