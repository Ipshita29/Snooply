#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const parser = require("@babel/parser");

console.log("Snooply is snooping around your project...");

const projectPath = process.cwd();
const packageJsonPath = path.join(projectPath, "package.json");

if (!fs.existsSync(packageJsonPath)) {
  console.log("Snooply couldn't find a package.json here.");
  process.exit(1);
}

const packageJson = JSON.parse(
  fs.readFileSync(packageJsonPath, "utf-8")
);

const dependencies = new Set([
  ...Object.keys(packageJson.dependencies || {}),
  ...Object.keys(packageJson.devDependencies || {}),
]);

console.log("\nSnooply found your dependencies:\n");

for (const dependency of dependencies) {
  console.log(`• ${dependency}`);
}

console.log("\nSnooply is checking your source files...\n");

function getJavaScriptFiles(directory) {
  const files = [];

  for (const item of fs.readdirSync(directory)) {
    if (
      item === "node_modules" ||
      item === ".git" ||
      item === "dist" ||
      item === "build"
    ) {
      continue;
    }

    const fullPath = path.join(directory, item);
    const stats = fs.statSync(fullPath);

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

const files = getJavaScriptFiles(projectPath);

const usage = {};

for (const dependency of dependencies) {
  usage[dependency] = new Set();
}

for (const filePath of files) {
  const code = fs.readFileSync(filePath, "utf-8");

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
    if (
      node.type === "VariableDeclaration" &&
      node.declarations[0]?.init?.type === "CallExpression" &&
      node.declarations[0].init.callee.name === "require"
    ) {
      const packageName =
        node.declarations[0].init.arguments[0]?.value;

      if (!packageName || !dependencies.has(packageName)) {
        continue;
      }

      const declaration = node.declarations[0];

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

console.log("Snooply found usage:\n");

for (const [dependency, used] of Object.entries(usage)) {
  if (used.size === 0) {
    console.log(`• ${dependency}: not detected`);
  } else {
    console.log(`• ${dependency}: ${[...used].join(", ")}`);
  }
}