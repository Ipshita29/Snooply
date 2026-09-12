# 🐾 Snooply

"Snoop through your dependencies."

## The problem

Developers often install large packages but end up using only a tiny part of them — a whole date library for one `format()` call, a whole utility library for `debounce`. Snooply looks through your project and finds dependencies that may deserve a second look, based on how you're actually using them — not guesses, not percentages.

## Usage

```bash
snooply
```

Run it from the root of any JS project (once linked/installed — see below).

## How it works

```
Project
  ↓
Dependencies (from package.json)
  ↓
Actual usage (scanned from your .js/.jsx files)
  ↓
Recommendation (only when there's real evidence)
```

Snooply scans your source files with `@babel/parser`, detects both ES `import` and CommonJS `require()`, and figures out exactly which named functions you use from each dependency. A package only gets flagged when the evidence supports it — heavily-used, core dependencies are left alone.

### Example

If your code only does this:

```js
import { debounce } from "lodash";
```

Snooply notices you're pulling in all of lodash for one function:

```
🐾 Snooply found something!

You're using only `debounce` from `lodash`.

💡 You're only using `debounce`.

Try `just-debounce-it` instead.
```

When Snooply doesn't know a reliable, lightweight alternative, it still flags the limited usage — it just won't invent a package name to recommend:

```
💡 This dependency might be worth a look.
```

Unused dependencies are called out too, separately, since they might not be needed at all.

## Status

This is the MVP core: dependency discovery, usage analysis, the recommendation engine, curated suggestions, and a small transparent overlay notification (a React UI) that appears over your editor with the result. It currently works on JavaScript projects (`.js`/`.jsx`, ES modules and CommonJS). Support for other languages or frameworks isn't implemented yet.
