// Strips comments and string literals out of C-family source (Java,
// Go, Rust) before regex-based import extraction runs, so text that
// only looks like an import - inside a comment, a string, or a
// multi-line raw string/text block - is never mistaken for real code.
//
// Stripped spans are replaced with spaces (newlines are kept), so line
// structure survives and everything downstream keeps working on the
// same line-by-line basis it already did.
//
// Deliberately does not touch single-quoted char literals ('a', '\n')
// - they're always too short to ever contain a fake import, and in
// Rust a bare `'` can also start a lifetime (`'static`) with no
// closing quote at all, which this simple scanner can't tell apart
// from a char literal without risking swallowing real code.
//
// `doubleQuoteStrings` defaults on, but Go turns it off: a Go import
// path IS a double-quoted string ("github.com/x/y"), so stripping
// those would erase the very data the Go analyzer needs to extract.
// Go's own multi-line false-positive risk (a raw string whose content
// happens to look like an import) only ever comes from backtick
// strings, which `backtickStrings` handles separately.
function stripCodeNoise(code, { nestedBlockComments = false, backtickStrings = false, doubleQuoteStrings = true } = {}) {
  let out = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];

    // Line comment - blank to end of line
    if (ch === "/" && next === "/") {
      while (i < n && code[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // Block comment - Rust nests these, Java/Go don't
    if (ch === "/" && next === "*") {
      let depth = 1;
      out += "  ";
      i += 2;
      while (i < n && depth > 0) {
        if (nestedBlockComments && code[i] === "/" && code[i + 1] === "*") {
          depth++;
          out += "  ";
          i += 2;
        } else if (code[i] === "*" && code[i + 1] === "/") {
          depth--;
          out += "  ";
          i += 2;
        } else {
          out += code[i] === "\n" ? "\n" : " ";
          i++;
        }
      }
      continue;
    }

    // Double-quoted string. Java text blocks ("""..."""..) are just
    // three quotes in a row - scanning quote-to-quote naturally treats
    // the run as a couple of empty strings plus the real content in
    // between, which ends up blanked out too. No special-casing needed.
    if (doubleQuoteStrings && ch === '"') {
      out += " ";
      i++;
      while (i < n && code[i] !== '"') {
        if (code[i] === "\\" && i + 1 < n) {
          out += "  ";
          i += 2;
        } else {
          out += code[i] === "\n" ? "\n" : " ";
          i++;
        }
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }

    // Backtick raw string (Go) - no escapes, can span many lines
    if (backtickStrings && ch === "`") {
      out += " ";
      i++;
      while (i < n && code[i] !== "`") {
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += " ";
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

module.exports = { stripCodeNoise };
