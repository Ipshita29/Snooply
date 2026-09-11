#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

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

const dependencies = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
};

console.log("\nSnooply found your dependencies:\n");

for (const dependency of Object.keys(dependencies)) {
  console.log(`• ${dependency}`);
}