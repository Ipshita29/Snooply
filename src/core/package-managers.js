// Package manager <-> manifest file mapping.
// npm and Python (pip) are implemented today. A future package
// manager (Maven, Cargo, Go modules, ...) registers here the same way.

const fs = require("fs");
const path = require("path");

const PACKAGE_MANAGERS = [
  { id: "npm", manifestFiles: ["package.json"] },
  { id: "python", manifestFiles: ["requirements.txt", "pyproject.toml"] },
];

// Manifest filenames Snooply knows how to recognize a workspace by
function manifestFileNames() {
  return PACKAGE_MANAGERS.flatMap((manager) => manager.manifestFiles);
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

  return { dependencies, devDependencyNames };
}

// Pull the package name off the front of a requirements.txt line
// (drops version specifiers and extras: "requests[security]>=2.0" -> "requests")
const REQUIREMENT_NAME = /^([A-Za-z0-9][A-Za-z0-9._-]*)/;

function parseRequirementsTxt(content) {
  const dependencies = new Set();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line || line.startsWith("-")) {
      continue; // blank, comment, or a -r/-e/--flag line
    }

    const match = line.match(REQUIREMENT_NAME);
    if (match) {
      dependencies.add(match[1]);
    }
  }

  return dependencies;
}

// Pull package names out of a quoted TOML array entry, e.g.
// `"requests>=2.0"` -> "requests"
function addTomlArrayEntries(arrayBody, dependencies) {
  const entryPattern = /"([^"]+)"|'([^']+)'/g;
  let match;
  while ((match = entryPattern.exec(arrayBody))) {
    const raw = match[1] || match[2];
    const nameMatch = raw.match(REQUIREMENT_NAME);
    if (nameMatch) {
      dependencies.add(nameMatch[1]);
    }
  }
}

// Only the two dependency shapes Snooply's MVP needs - not a full
// TOML parser. [project] dependencies (PEP 621) and Poetry's table.
function parsePyprojectToml(content) {
  const dependencies = new Set();

  const projectMatch = content.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (projectMatch) {
    addTomlArrayEntries(projectMatch[1], dependencies);
  }

  const poetryMatch = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/);
  if (poetryMatch) {
    for (const rawLine of poetryMatch[1].split("\n")) {
      const line = rawLine.split("#")[0].trim();
      const nameMatch = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
      if (nameMatch && nameMatch[1].toLowerCase() !== "python") {
        dependencies.add(nameMatch[1]);
      }
    }
  }

  return dependencies;
}

// Read requirements.txt and/or pyproject.toml into dependency names
function readPythonManifest(root) {
  const dependencies = new Set();
  let found = false;

  const requirementsPath = path.join(root, "requirements.txt");
  if (fs.existsSync(requirementsPath)) {
    found = true;
    for (const dep of parseRequirementsTxt(fs.readFileSync(requirementsPath, "utf-8"))) {
      dependencies.add(dep);
    }
  }

  const pyprojectPath = path.join(root, "pyproject.toml");
  if (fs.existsSync(pyprojectPath)) {
    found = true;
    for (const dep of parsePyprojectToml(fs.readFileSync(pyprojectPath, "utf-8"))) {
      dependencies.add(dep);
    }
  }

  if (!found) {
    throw new Error(`No Python manifest found at ${root}`);
  }

  // Python dependencies have no dev/prod split in the manifests we support
  return { dependencies, devDependencyNames: new Set() };
}

// Read every manifest present in a workspace root and merge them.
// A workspace is usually just one ecosystem, but this doesn't assume
// that - an npm and a Python manifest side by side both get picked up.
function readManifest(root) {
  const dependencies = new Set();
  const devDependencyNames = new Set();
  let found = false;

  if (fs.existsSync(path.join(root, "package.json"))) {
    const npm = readNpmManifest(root);
    found = true;
    for (const dep of npm.dependencies) dependencies.add(dep);
    for (const dep of npm.devDependencyNames) devDependencyNames.add(dep);
  }

  if (fs.existsSync(path.join(root, "requirements.txt")) || fs.existsSync(path.join(root, "pyproject.toml"))) {
    const python = readPythonManifest(root);
    found = true;
    for (const dep of python.dependencies) dependencies.add(dep);
  }

  if (!found) {
    throw new Error(`No package manifest found at ${root}`);
  }

  return { dependencies, devDependencyNames };
}

module.exports = { manifestFileNames, readNpmManifest, readPythonManifest, readManifest };
