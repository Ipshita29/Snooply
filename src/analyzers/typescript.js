// TypeScript/TSX analyzer.
// A thin config over the shared Babel engine - see
// src/analyzers/babel.js for the actual parsing logic.
//
// .tsx files need the jsx plugin too. Plain .ts files must NOT enable
// it - TypeScript's `<Type>value` cast syntax collides with JSX there.
//
// Known limitation: decorators (e.g. `@Component`) aren't supported
// yet. A file using them will fail to parse and show up as skipped -
// add the decorators Babel plugin later if this becomes a real need.

const { createBabelAnalyzer } = require("./babel");

module.exports = createBabelAnalyzer({
  name: "typescript",
  extensions: [".ts", ".tsx"],
  getParserPlugins: (filePath) => (filePath.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"]),
  // .d.ts files are type declarations, not application source
  shouldAnalyze: (filePath) => !filePath.endsWith(".d.ts"),
});
