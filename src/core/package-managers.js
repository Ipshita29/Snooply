// Package manager <-> manifest file mapping. This is the single
// source of truth for every package manager Snooply understands - its
// manifest files, which language(s) it belongs to, its dependency
// reader, and (where one safely exists) its uninstall/install command.
// A future package manager (Composer, Bundler, ...) registers here the
// same way; nothing else in the codebase should hardcode manager ids,
// manifest filenames, or command strings.

const fs = require("fs");
const path = require("path");

const PACKAGE_MANAGERS = [
  {
    id: "npm",
    manifestFiles: ["package.json"],
    // An npm workspace can hold both JS and TS source; javascript is
    // the representative language attached to dependency metadata.
    sourceLanguages: ["javascript", "typescript"],
    read: (root) => readNpmManifest(root),
    uninstallCommand: (name) => `npm uninstall ${name}`,
    installCommand: (names) => `npm install ${names.join(" ")}`,
  },
  {
    id: "pip",
    manifestFiles: ["requirements.txt", "pyproject.toml"],
    sourceLanguages: ["python"],
    read: (root) => readPythonManifest(root),
    uninstallCommand: (name) => `pip uninstall ${name}`,
    installCommand: (names) => `pip install ${names.join(" ")}`,
  },
  {
    id: "maven",
    manifestFiles: ["pom.xml"],
    sourceLanguages: ["java"],
    read: (root) => readMavenManifest(root),
    // No safe, universal one-line Maven CLI command removes a
    // dependency from pom.xml - that's a manual file edit. Leaving
    // uninstallCommand/installCommand undefined rather than guessing.
  },
  {
    id: "gradle",
    manifestFiles: ["build.gradle", "build.gradle.kts"],
    sourceLanguages: ["java"],
    read: (root) => readGradleManifest(root),
    // Same reasoning as Maven - removing a Gradle dependency means
    // editing the build file, there's no safe CLI equivalent to offer.
  },
  {
    id: "go",
    manifestFiles: ["go.mod"],
    sourceLanguages: ["go"],
    read: (root) => readGoManifest(root),
    // Removing a Go dependency means editing go.mod (and usually
    // running `go mod tidy`, which Snooply won't execute) - no safe
    // one-line command to offer here either.
  },
  {
    id: "cargo",
    manifestFiles: ["Cargo.toml"],
    sourceLanguages: ["rust"],
    read: (root) => readCargoManifest(root),
    // Same reasoning as the others - removing a crate means editing
    // Cargo.toml, there's no safe one-line `cargo` command to offer.
  },
];

// Does this manager's manifest exist in this directory?
function managerAppliesTo(manager, root) {
  return manager.manifestFiles.some((file) => fs.existsSync(path.join(root, file)));
}

// Manifest filenames Snooply knows how to recognize a workspace by
function manifestFileNames() {
  return PACKAGE_MANAGERS.flatMap((manager) => manager.manifestFiles);
}

// Look up a manager's metadata by id. Returns null for an unknown id -
// never guesses at a manager that isn't actually registered.
function getPackageManager(id) {
  return PACKAGE_MANAGERS.find((manager) => manager.id === id) || null;
}

// Which package manager governs a directory, based on its manifest
// file(s). Returns null if none is present. If a directory has more
// than one manifest (rare - an npm + a Python service in the same
// folder), this returns the first match; `readManifest` below is the
// authoritative source for that case, since it reads every manifest
// present and keeps per-dependency attribution.
function detectPackageManager(root) {
  const manager = PACKAGE_MANAGERS.find((candidate) => managerAppliesTo(candidate, root));
  return manager ? manager.id : null;
}

// Primary language associated with a package manager. Used to tag
// dependency metadata; returns null for an unknown id.
function languageFor(packageManagerId) {
  const manager = getPackageManager(packageManagerId);
  return manager ? manager.sourceLanguages[0] : null;
}

// Internal-only lookup for building commands. Unlike getPackageManager,
// this always returns something - it's only ever called with an id
// Snooply itself already assigned, so a safe npm fallback is fine here.
function findPackageManager(id) {
  return getPackageManager(id) || PACKAGE_MANAGERS[0];
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

// Read `require` entries from a go.mod file - both the single-line
// and grouped block forms. Version and "// indirect" comments are
// dropped; only the module path (the dependency identity) is kept.
function parseGoMod(content) {
  const dependencies = new Set();

  const blockPattern = /require\s*\(([\s\S]*?)\)/g;
  let blockMatch;
  while ((blockMatch = blockPattern.exec(content))) {
    for (const rawLine of blockMatch[1].split("\n")) {
      const line = rawLine.split("//")[0].trim();
      const match = line.match(/^(\S+)\s+v\S+/);
      if (match) {
        dependencies.add(match[1]);
      }
    }
  }

  // Single-line requires live outside any require(...) block
  const withoutBlocks = content.replace(/require\s*\([\s\S]*?\)/g, "");
  for (const rawLine of withoutBlocks.split("\n")) {
    const line = rawLine.split("//")[0].trim();
    const match = line.match(/^require\s+(\S+)\s+v\S+/);
    if (match) {
      dependencies.add(match[1]);
    }
  }

  return dependencies;
}

function readGoManifest(root) {
  const goModPath = path.join(root, "go.mod");
  if (!fs.existsSync(goModPath)) {
    throw new Error(`No go.mod found at ${root}`);
  }

  const dependencies = parseGoMod(fs.readFileSync(goModPath, "utf-8"));
  return { dependencies, devDependencyNames: new Set() };
}

// TOML sections that declare Cargo dependencies. Dev and build
// dependencies are included too - they're still declared dependencies,
// just usually imported from tests/ or build.rs instead of src/.
function isCargoDependencySection(section) {
  return /^(dependencies|dev-dependencies|build-dependencies|target\.[^.]+\.dependencies)$/.test(section);
}

// Read dependency keys out of a Cargo.toml. The declared dependency
// identity is always the TOML key on the left of "=" - even for a
// renamed dependency like `my_json = { package = "serde_json" }`,
// where the source imports it as `my_json`, not `serde_json`.
function parseCargoToml(content) {
  const dependencies = new Set();
  let inDependencySection = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line) {
      continue;
    }

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const section = sectionMatch[1];

      // [dependencies.some-crate] declares one dependency directly
      const namedSection = section.match(/^(?:dependencies|dev-dependencies|build-dependencies)\.([A-Za-z0-9_-]+)$/);
      if (namedSection) {
        dependencies.add(namedSection[1]);
        inDependencySection = false;
        continue;
      }

      inDependencySection = isCargoDependencySection(section);
      continue;
    }

    if (!inDependencySection) {
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (keyMatch) {
      dependencies.add(keyMatch[1]);
    }
  }

  return dependencies;
}

function readCargoManifest(root) {
  const cargoPath = path.join(root, "Cargo.toml");
  if (!fs.existsSync(cargoPath)) {
    throw new Error(`No Cargo.toml found at ${root}`);
  }

  const dependencies = parseCargoToml(fs.readFileSync(cargoPath, "utf-8"));
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

  for (const manager of PACKAGE_MANAGERS) {
    if (!managerAppliesTo(manager, root)) {
      continue;
    }

    const result = manager.read(root);
    found = true;

    for (const dep of result.dependencies) {
      dependencies.add(dep);
      packageManagers[dep] = manager.id;
    }
    for (const dep of result.devDependencyNames) {
      devDependencyNames.add(dep);
    }
  }

  if (!found) {
    throw new Error(`No package manifest found at ${root}`);
  }

  return { dependencies, devDependencyNames, packageManagers };
}

module.exports = {
  manifestFileNames,
  detectPackageManager,
  getPackageManager,
  languageFor,
  readNpmManifest,
  readPythonManifest,
  readMavenManifest,
  readGradleManifest,
  readGoManifest,
  readCargoManifest,
  readManifest,
  uninstallCommandFor,
  installCommandFor,
};
