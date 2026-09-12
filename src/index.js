#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");
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
// Displays the structured data already produced by the recommendation and
// suggestion engines above — it never recomputes a verdict or a suggestion
// itself. Implemented as native macOS dialogs (via osascript) so there's no
// UI framework, browser, or extra dependency involved. Each "screen" is one
// small, disposable AppleScript process; nothing lingers after it closes.

function escapeAppleScript(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScript(script) {
  const tmpFile = path.join(os.tmpdir(), `snooply-popup-${Date.now()}.applescript`);
  fs.writeFileSync(tmpFile, script, "utf-8");

  try {
    return execSync(`osascript "${tmpFile}"`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function showDialog(text, buttons, defaultButton) {
  const buttonList = buttons.map((b) => `"${escapeAppleScript(b)}"`).join(", ");
  const script = [
    `set dialogResult to display dialog "${escapeAppleScript(text)}" with title "🐾 Snooply" buttons {${buttonList}} default button "${escapeAppleScript(defaultButton)}" with icon note`,
    "button returned of dialogResult",
  ].join("\n");

  try {
    return runAppleScript(script);
  } catch (error) {
    return null;
  }
}

function chooseFromList(items, prompt) {
  const itemList = items.map((i) => `"${escapeAppleScript(i)}"`).join(", ");
  const script = [
    `set chosen to choose from list {${itemList}} with title "🐾 Snooply" with prompt "${escapeAppleScript(prompt)}"`,
    "if chosen is false then",
    '  return "CANCELLED"',
    "end if",
    "item 1 of chosen",
  ].join("\n");

  try {
    return runAppleScript(script);
  } catch (error) {
    return null;
  }
}

function fallbackSuggestionFor(item) {
  if (item.suggestion) {
    return item.suggestion;
  }

  return item.used.length > 0
    ? "You might not need the whole package."
    : "You might not need this dependency at all.";
}

function buildExploreText(item) {
  return [
    "Dependency:",
    item.dependency,
    "",
    "Used:",
    item.used.length ? item.used.join(", ") : "none detected",
    "",
    "Reason:",
    item.reason,
    "",
    "Suggestion:",
    fallbackSuggestionFor(item),
  ].join("\n");
}

function exploreItem(item) {
  showDialog(buildExploreText(item), ["Close"], "Close");
}

function buildAllDependenciesText(dependencies, usage) {
  const lines = [...dependencies].map((dependency) => {
    const used = usage[dependency];
    return used && used.size > 0
      ? `• ${dependency}: ${[...used].join(", ")}`
      : `• ${dependency}: not detected`;
  });

  return ["All dependencies:", "", ...lines].join("\n");
}

function showAllDependencies(dependencies, usage) {
  showDialog(buildAllDependenciesText(dependencies, usage), ["Close"], "Close");
}

function showSingleRecommendationPopup(item, dependencies, usage) {
  const text = [
    "🐾",
    "",
    "Snooply found something!",
    "",
    item.reason,
    "",
    `💡 ${fallbackSuggestionFor(item)}`,
  ].join("\n");

  const button = showDialog(text, ["Close", "See all dependencies", "Explore"], "Explore");

  if (button === "Explore") {
    exploreItem(item);
  } else if (button === "See all dependencies") {
    showAllDependencies(dependencies, usage);
  }
}

function showMultipleRecommendationsPopup(items, dependencies, usage) {
  const sections = items.map((item) => {
    const usedBlock = item.used.length
      ? ["You're only using:", ...item.used.map((fn) => `✓ ${fn}`)].join("\n")
      : item.reason;

    return [item.dependency, "", usedBlock, "", `💡 ${fallbackSuggestionFor(item)}`].join("\n");
  });

  const text = [
    `🐾 Snooply found ${items.length} things!`,
    "",
    "I think these are worth a look 👀",
    "",
    sections.join("\n\n━━━━━━━━━━━━━━━━━━\n\n"),
  ].join("\n");

  const button = showDialog(text, ["Close", "See all dependencies", "Explore"], "Explore");

  if (button === "Explore") {
    const names = items.map((item) => item.dependency);
    const chosen = chooseFromList(names, "Which dependency would you like to explore?");
    const chosenItem = items.find((item) => item.dependency === chosen);

    if (chosenItem) {
      exploreItem(chosenItem);
    }
  } else if (button === "See all dependencies") {
    showAllDependencies(dependencies, usage);
  }
}

function showNoRecommendationsPopup(dependencies, usage) {
  const text = [
    "🐾",
    "",
    "Snooply took a little look…",
    "",
    "Everything looks pretty reasonable! ♡",
    "",
    "Nothing worth bothering you about right now.",
  ].join("\n");

  const button = showDialog(text, ["Close", "See all dependencies"], "Close");

  if (button === "See all dependencies") {
    showAllDependencies(dependencies, usage);
  }
}

function isPopupSupported() {
  if (process.platform !== "darwin") {
    return false;
  }

  try {
    execSync("which osascript", { stdio: "ignore" });
    return true;
  } catch (error) {
    return false;
  }
}

function showPopup(flaggedItems, dependencies, usage) {
  if (!isPopupSupported()) {
    console.log("(Popup isn't available on this platform yet — terminal output above is it for now.)");
    return;
  }

  try {
    if (flaggedItems.length === 0) {
      showNoRecommendationsPopup(dependencies, usage);
    } else if (flaggedItems.length === 1) {
      showSingleRecommendationPopup(flaggedItems[0], dependencies, usage);
    } else {
      showMultipleRecommendationsPopup(flaggedItems, dependencies, usage);
    }
  } catch (error) {
    // Popup dismissed or unavailable mid-flow — never crash the CLI over it.
  }
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

  const flaggedItems = [...recommendations, ...unused];

  if (flaggedItems.length === 0) {
    console.log("🐾 Snooply took a little look...");
    console.log("Everything looks pretty reasonable! ♡");
  } else if (flaggedItems.length === 1) {
    console.log("🐾 Snooply found something!");
  } else {
    console.log(`🐾 Snooply found ${flaggedItems.length} things!`);
  }

  showPopup(flaggedItems, dependencies, usage);
}

main().catch(() => {
  console.log("🐾 Snooply hit a snag and had to stop.");
  process.exitCode = 1;
});