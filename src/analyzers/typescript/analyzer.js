// TypeScript/TSX analyzer.
// A thin config over the shared Babel engine - see
// src/analyzers/shared/babel-analyzer.js for the actual parsing logic.
//
// .tsx files need the jsx plugin too. Plain .ts files must NOT enable
// it - TypeScript's `<Type>value` cast syntax collides with JSX there.

const { createBabelAnalyzer } = require("../shared/babel-analyzer");

module.exports = createBabelAnalyzer({
  name: "typescript",
  extensions: [".ts", ".tsx"],
  getParserPlugins: (filePath) => (filePath.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"]),
});
