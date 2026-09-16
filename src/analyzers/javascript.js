// JavaScript/JSX analyzer.
// A thin config over the shared Babel engine - see
// src/analyzers/babel.js for the actual parsing logic.

const { createBabelAnalyzer } = require("./babel");

module.exports = createBabelAnalyzer({
  name: "javascript",
  extensions: [".js", ".jsx"],
  getParserPlugins: () => ["jsx"],
});
