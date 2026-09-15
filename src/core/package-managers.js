// Package manager <-> manifest file mapping.
// Only npm is implemented today. A future package manager (pip,
// Maven, Cargo, Go modules, ...) registers here the same way.

const fs = require("fs");
const path = require("path");

const PACKAGE_MANAGERS = [{ id: "npm", manifestFile: "package.json" }];

// Manifest filenames Snooply knows how to recognize a workspace by
function manifestFileNames() {
  return PACKAGE_MANAGERS.map((manager) => manager.manifestFile);
}

// Read an npm package.json into dependency names
// (throws on missing/invalid JSON - callers decide how to handle that)
function readNpmManifest(root) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

  const devDependencyNames = new Set(Object.keys(packageJson.devDependencies || {}));
  const dependencies = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...devDependencyNames,
  ]);

  return { packageJson, dependencies, devDependencyNames };
}

module.exports = { manifestFileNames, readNpmManifest };
