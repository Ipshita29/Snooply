// Orchestration layer: picks the language analyzer(s) that apply to a
// workspace, runs them, and combines their results into the shape the
// rest of Snooply (recommendations, CLI, popup) already expects.
//
// Only the JavaScript analyzer exists today, so this always runs
// exactly one analyzer - but a workspace could have more than one in
// the future (e.g. a JS frontend and a Python backend side by side).

const javascriptAnalyzer = require("../analyzers/javascript/analyzer");

const ANALYZERS = [javascriptAnalyzer];

// Which registered analyzers apply to this workspace
function selectAnalyzers(root) {
  return ANALYZERS.filter((analyzer) => analyzer.canAnalyze(root));
}

// Run every matching analyzer and merge their usage data into one result
async function analyzeWorkspace(root, dependencies, excludedDirs = new Set()) {
  const analyzers = selectAnalyzers(root);

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
