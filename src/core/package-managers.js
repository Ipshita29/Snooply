// Package manager <-> manifest file mapping.
// npm, Python (pip), Maven, and Gradle are implemented today. A future
// package manager (Cargo, Go modules, ...) registers here the same way.

const fs = require("fs");
const path = require("path");

const PACKAGE_MANAGERS = [
  {
    id: "npm",
    manifestFiles: ["package.json"],
    uninstallCommand: (name) => `npm uninstall ${name}`,
    installCommand: (names) => `npm install ${names.join(" ")}`,
  },
  {
    id: "pip",
    manifestFiles: ["requirements.txt", "pyproject.toml"],
    uninstallCommand: (name) => `pip uninstall ${name}`,
    installCommand: (names) => `pip install ${names.join(" ")}`,
  },
  {
    id: "maven",
    manifestFiles: ["pom.xml"],
    // No safe, universal one-line Maven CLI command removes a
    // dependency from pom.xml - that's a manual file edit. Leaving
    // uninstallCommand/installCommand undefined rather than guessing.
  },
  {
    id: "gradle",
    manifestFiles: ["build.gradle", "build.gradle.kts"],
    // Same reasoning as Maven - removing a Gradle dependency means
    // editing the build file, there's no safe CLI equivalent to offer.
  },
];

// Manifest filenames Snooply knows how to recognize a workspace by
function manifestFileNames() {
  return PACKAGE_MANAGERS.flatMap((manager) => manager.manifestFiles);
}

function findPackageManager(id) {
  return PACKAGE_MANAGERS.find((manager) => manager.id === id) || PACKAGE_MANAGERS[0];
}

// Build the real remove/add command for a dependency, based on which
// package manager actually declared it - not the dependency's name.
// Returns null if that manager doesn't have a safe command defined.
function uninstallCommandFor(packageManagerId, name) {
  const manager = findPackageManager(packageManagerId);
  return manager.uninstallCommand ? manager.uninstallCommand(name) : null;
}

function installCommandFor(packageManagerId, names) {
  const manager = findPackageManager(packageManagerId);
  return manager.installCommand ? manager.installCommand(names) : null;
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

// Read <dependency> entries out of a pom.xml. Dependency identity is
// "groupId:artifactId" (version is dropped - Snooply doesn't care which
// version is installed, only whether the dependency is used).
// Skips <dependencyManagement> - that section only pins versions for
// child modules, it doesn't mean this module actually uses them.
function parsePomXml(content) {
  const dependencies = new Set();
  const withoutManagement = content.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "");

  const depBlockPattern = /<dependency>([\s\S]*?)<\/dependency>/g;
  let match;
  while ((match = depBlockPattern.exec(withoutManagement))) {
    const block = match[1];
    const groupId = block.match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/);
    const artifactId = block.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/);
    if (groupId && artifactId) {
      dependencies.add(`${groupId[1]}:${artifactId[1]}`);
    }
  }

  return dependencies;
}

function readMavenManifest(root) {
  const pomPath = path.join(root, "pom.xml");
  if (!fs.existsSync(pomPath)) {
    throw new Error(`No pom.xml found at ${root}`);
  }

  const dependencies = parsePomXml(fs.readFileSync(pomPath, "utf-8"));
  return { dependencies, devDependencyNames: new Set() };
}

// Configurations Snooply recognizes in a Gradle build file. Test
// dependencies are included here too - they're still declared
// dependencies, just usually imported from src/test/java instead.
const GRADLE_CONFIGS = ["implementation", "api", "compileOnly", "runtimeOnly", "testImplementation", "testRuntimeOnly"];
const GRADLE_DEPENDENCY_LINE = new RegExp(`^(?:${GRADLE_CONFIGS.join("|")})\\s*[(]?\\s*['"]([^'"]+)['"]`);

// Read "implementation 'group:artifact:version'" style declarations
// (Groovy and Kotlin DSL both use this shape, with or without parens)
function parseGradleDependencies(content) {
  const dependencies = new Set();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.split("//")[0].trim();
    const match = line.match(GRADLE_DEPENDENCY_LINE);
    if (!match) {
      continue;
    }

    const segments = match[1].split(":");
    if (segments.length >= 2) {
      dependencies.add(`${segments[0]}:${segments[1]}`);
    }
  }

  return dependencies;
}

function readGradleManifest(root) {
  const dependencies = new Set();
  let found = false;

  for (const filename of ["build.gradle", "build.gradle.kts"]) {
    const filePath = path.join(root, filename);
    if (fs.existsSync(filePath)) {
      found = true;
      for (const dep of parseGradleDependencies(fs.readFileSync(filePath, "utf-8"))) {
        dependencies.add(dep);
      }
    }
  }

  if (!found) {
    throw new Error(`No Gradle build file found at ${root}`);
  }

  return { dependencies, devDependencyNames: new Set() };
}

// Read every manifest present in a workspace root and merge them.
// A workspace is usually just one ecosystem, but this doesn't assume
// that - an npm and a Python manifest side by side both get picked up.
// `packageManagers` records which manager declared each dependency, so
// later steps (like building an uninstall command) use the real tool
// instead of guessing from the dependency's name.
function readManifest(root) {
  const dependencies = new Set();
  const devDependencyNames = new Set();
  const packageManagers = {};
  let found = false;

  if (fs.existsSync(path.join(root, "package.json"))) {
    const npm = readNpmManifest(root);
    found = true;
    for (const dep of npm.dependencies) {
      dependencies.add(dep);
      packageManagers[dep] = "npm";
    }
    for (const dep of npm.devDependencyNames) devDependencyNames.add(dep);
  }

  if (fs.existsSync(path.join(root, "requirements.txt")) || fs.existsSync(path.join(root, "pyproject.toml"))) {
    const python = readPythonManifest(root);
    found = true;
    for (const dep of python.dependencies) {
      dependencies.add(dep);
      packageManagers[dep] = "pip";
    }
  }

  if (fs.existsSync(path.join(root, "pom.xml"))) {
    const maven = readMavenManifest(root);
    found = true;
    for (const dep of maven.dependencies) {
      dependencies.add(dep);
      packageManagers[dep] = "maven";
    }
  }

  if (fs.existsSync(path.join(root, "build.gradle")) || fs.existsSync(path.join(root, "build.gradle.kts"))) {
    const gradle = readGradleManifest(root);
    found = true;
    for (const dep of gradle.dependencies) {
      dependencies.add(dep);
      packageManagers[dep] = "gradle";
    }
  }

  if (!found) {
    throw new Error(`No package manifest found at ${root}`);
  }

  return { dependencies, devDependencyNames, packageManagers };
}

module.exports = {
  manifestFileNames,
  readNpmManifest,
  readPythonManifest,
  readMavenManifest,
  readGradleManifest,
  readManifest,
  uninstallCommandFor,
  installCommandFor,
};
