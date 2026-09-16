// Recommendation engine - decides what's worth flagging from usage
// evidence. Only two kinds of finding: UNUSED (no usage found) and
// KNOWN_ALTERNATIVE (narrow usage + a known smaller replacement).
// Using a couple of functions from a big library is normal, not
// suspicious, so that alone is never a reason to flag something.
//
// This only looks at usage evidence - it doesn't care which language
// analyzer produced it.
//
// Every finding also carries an internal confidence level (HIGH,
// MEDIUM, LOW) based on how much of the project Snooply could actually
// read and how directly its evidence maps to the dependency. LOW
// findings are never shown - Snooply would rather say nothing than
// confidently guess wrong. This is never exposed as a score, just used
// to decide whether a finding is trustworthy enough to surface, and to
// keep MEDIUM wording appropriately cautious.

// Snooply must never flag itself. If Snooply is installed as a
// dependency of the project it's analyzing, it would otherwise show
// up as "unused" since a project never imports its own CLI tool.
const SELF_PACKAGE_NAME = "snooply";

const CONFIDENCE = { HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" };
const CONFIDENCE_RANK = { HIGH: 2, MEDIUM: 1, LOW: 0 };

// The most cautious of several confidence signals
function lowestConfidence(...levels) {
  return levels.reduce((worst, level) => (CONFIDENCE_RANK[level] < CONFIDENCE_RANK[worst] ? level : worst), CONFIDENCE.HIGH);
}

// How much of the workspace's source Snooply actually managed to read.
// A dependency can't be confidently called "unused" if a meaningful
// share of the source that might use it never got checked.
function parseCoverageConfidence(skippedFileCount, totalFileCount) {
  if (!totalFileCount || skippedFileCount === 0) {
    return CONFIDENCE.HIGH;
  }
  if (skippedFileCount / totalFileCount >= 0.5) {
    return CONFIDENCE.LOW;
  }
  return CONFIDENCE.MEDIUM;
}

// Markers for "used, but no specific function name"
const NON_SPECIFIC_MARKERS = new Set(["default", "*", "JSX"]);

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
    reason: `You're only using ${formatBacktickList(namedUsage)} from \`${name}\`.`,
    suggestion: `If ${formatBacktickList(namedUsage)} ${namedUsage.length === 1 ? "is" : "are"} all you need, consider ${formatBacktickList(alternative.packages)} instead.`,
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

// Cautious wording added to a MEDIUM-confidence finding - never claim
// more certainty than the evidence actually supports.
function withCaveat(reason, coverage, mapping) {
  const notes = [];
  if (coverage === CONFIDENCE.MEDIUM) {
    notes.push("Some source files in this project couldn't be checked, so this may not be fully accurate.");
  }
  if (mapping === CONFIDENCE.MEDIUM) {
    notes.push("This is based on a less direct package-to-import match.");
  }
  return notes.length > 0 ? `${reason} ${notes.join(" ")}` : reason;
}

// Create dependency recommendations.
// `context` carries the same evidence the analyzers already produced -
// how many source files were skipped/scanned, and (for a dependency
// matched through a less direct mapping, e.g. Java's groupId fallback)
// a per-dependency confidence hint. Nothing here is invented; it's
// existing evidence, just used to decide how much to trust a finding.
function buildResults(usage, devDependencyNames, context = {}) {
  const { skippedFiles = [], totalFiles = 0, matchConfidence = {} } = context;
  const coverage = parseCoverageConfidence(skippedFiles.length, totalFiles);

  const recommendations = [];
  const unused = [];

  for (const [dependency, used] of Object.entries(usage)) {
    if (dependency === SELF_PACKAGE_NAME) {
      continue;
    }

    const result = evaluateDependency(dependency, used, devDependencyNames.has(dependency));

    if (result.status === "NO_FINDING") {
      continue;
    }

    // A dependency that already has usage evidence is never "unused",
    // so a less-direct mapping only matters for a KNOWN_ALTERNATIVE claim
    const mapping = matchConfidence[dependency] === "medium" ? CONFIDENCE.MEDIUM : CONFIDENCE.HIGH;
    const confidence = result.status === "UNUSED" ? coverage : lowestConfidence(coverage, mapping);

    // Not enough evidence to say anything useful - stay quiet rather
    // than show a noisy, unreliable "maybe" recommendation
    if (confidence === CONFIDENCE.LOW) {
      continue;
    }

    const reason = confidence === CONFIDENCE.MEDIUM ? withCaveat(result.reason, coverage, mapping) : result.reason;

    if (result.status === "KNOWN_ALTERNATIVE") {
      recommendations.push({
        dependency,
        used: result.used,
        reason,
        suggestion: result.suggestion,
        suggestedPackages: result.suggestedPackages,
        hasAlternative: true,
        confidence,
      });
    } else if (result.status === "UNUSED") {
      unused.push({
        dependency,
        used: [],
        reason,
        suggestion: result.suggestion,
        suggestedPackages: [],
        hasAlternative: false,
        confidence,
      });
    }
  }

  return { recommendations, unused };
}

module.exports = { buildResults, formatUsageForDisplay, CONFIDENCE };
