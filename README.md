# 🐾 Snooply

Snooply snoops around your project and tells you when a dependency might be more than you actually need — no dashboards, no percentages, just a straight-up heads-up.

```
🐾 Snooply found something!

You're using only `debounce` from `lodash`.

💡 You might not need the whole package.
```

## What it does

- Finds your `package.json` and reads its dependencies
- Scans your `.js`/`.jsx` files (ES imports + CommonJS `require`)
- Figures out exactly which functions you use from each package
- Flags dependencies worth a second look — and stays quiet about the ones that are fine

## Usage

```bash
node src/index.js
```

Run it from the root of any JS project.

## Status

Early days — this is an evolving CLI, not a finished product yet. More coming soon.
