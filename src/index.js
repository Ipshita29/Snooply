#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
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

const KNOWN_ALTERNATIVES = {
  lodash: {
    debounce: "a small debounce utility",
    throttle: "a small throttle utility",
  },
};

function getSuggestion(dependency, namedUsage) {
  const known = KNOWN_ALTERNATIVES[dependency];

  if (!known || namedUsage.length === 0) {
    return null;
  }

  const alternatives = [];

  for (const fn of namedUsage) {
    if (!known[fn]) {
      return null;
    }

    if (!alternatives.includes(known[fn])) {
      alternatives.push(known[fn]);
    }
  }

  return `${capitalize(joinWithAnd(alternatives))} may work here instead of the whole package.`;
}

function joinWithAnd(items) {
  if (items.length === 1) {
    return items[0];
  }

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
        suggestion,
        hasAlternative: suggestion !== null,
      });
    } else if (result.status === "UNUSED") {
      unused.push({
        dependency,
        used: [],
        reason: result.reason,
        suggestion: null,
        hasAlternative: false,
      });
    }
  }

  return { recommendations, unused };
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

  if (recommendations.length === 0 && unused.length === 0) {
    console.log("🐾 Snooply took a little look...");
    console.log("Everything looks pretty reasonable! ♡");
  } else {
    // Part 5 will replace these detail blocks with the popup — kept for
    // now so the recommendation output isn't lost in the meantime.
    console.log("🐾 Snooply found something!\n");

    for (const { reason, suggestion } of recommendations) {
      console.log(reason);
      console.log(`💡 ${suggestion || "You might not need the whole package."}\n`);
    }

    for (const { reason } of unused) {
      console.log(reason);
      console.log("💡 You might not need this dependency at all.\n");
    }
  }
}

main().catch(() => {
  console.log("🐾 Snooply hit a snag and had to stop.");
  process.exitCode = 1;
});