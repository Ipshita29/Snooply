// Orchestration layer: picks the language analyzer(s) that apply to a
// workspace, runs them, and combines their results into the shape the
// rest of Snooply (recommendations, CLI, popup) already expects.
//
// A workspace can have more than one analyzer apply - e.g. a project
// with both .jsx and .tsx files runs both and their results merge.

const { findExtensionsPresent } = require("./project");
const javascriptAnalyzer = require("../analyzers/javascript/analyzer");
const typescriptAnalyzer = require("../analyzers/typescript/analyzer");
const pythonAnalyzer = require("../analyzers/python/analyzer");

const ANALYZERS = [javascriptAnalyzer, typescriptAnalyzer, pythonAnalyzer];

// Which registered analyzers apply to this workspace - based on which
// file extensions actually show up there, not just "has a package.json".
// One scan decides this for every analyzer, instead of each analyzer
// walking the tree itself to find out whether it's needed.
function selectAnalyzers(root, excludedDirs = new Set()) {
  const extensionsPresent = findExtensionsPresent(root, excludedDirs);
  return ANALYZERS.filter((analyzer) => analyzer.canAnalyze(root, extensionsPresent));
}

// Run every matching analyzer and merge their usage data into one result
async function analyzeWorkspace(root, dependencies, excludedDirs = new Set()) {
  const analyzers = selectAnalyzers(root, excludedDirs);

  const languages = [];
  const files = [];
  const skippedFiles = [];
  const usage = {};
  const usageByFile = {};

  for (const dependency of dependencies) {
    usage[dependency] = new Set();
    usageByFile[dependency] = [];
  }

  for (const analyzer of analyzers) {
    const result = await analyzer.analyze(root, dependencies, excludedDirs);

    languages.push(result.language);
    files.push(...result.sourceFiles);
    skippedFiles.push(...result.skippedFiles);

    for (const dependency of dependencies) {
      for (const evidence of result.usage[dependency] || []) {
        usage[dependency].add(evidence);
      }
      usageByFile[dependency].push(...(result.usageByFile[dependency] || []));
    }
  }

  return { languages, files, skippedFiles, usage, usageByFile };
}

module.exports = { analyzeWorkspace, selectAnalyzers };
