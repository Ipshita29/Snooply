// JavaScript/JSX analyzer.
//
// Finds .js/.jsx source files in a workspace, parses them, and reports
// which declared dependencies they actually use. It only understands
// JavaScript - it doesn't know about recommendations, the CLI, or the
// popup. Those live above this, in core/ and index.js.

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");
const { findSourceFiles } = require("../../core/project");

const EXTENSIONS = [".js", ".jsx"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// Scan a workspace's JavaScript/JSX files and collect dependency usage
async function analyze(root, dependencies, excludedDirs = new Set()) {
  const files = findSourceFiles(root, EXTENSIONS, excludedDirs);
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

  return { language: "javascript", sourceFiles: files, usage, usageByFile, skippedFiles };
}

// This analyzer applies to any workspace npm can see (has a package.json)
function canAnalyze(root) {
  return fs.existsSync(path.join(root, "package.json"));
}

module.exports = {
  name: "javascript",
  extensions: EXTENSIONS,
  canAnalyze,
  analyze,
};
