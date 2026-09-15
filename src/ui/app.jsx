(function () {
  const h = React.createElement;

  function getData() {
    const el = document.getElementById("snooply-data");
    const fallback = { items: [], dependencies: [], usage: {}, version: null, verbose: false, project: null, packages: [], dependencyUsage: [] };
    try {
      return { ...fallback, ...JSON.parse(el.textContent) };
    } catch (error) {
      return fallback;
    }
  }

  function closeServer() {
    try {
      navigator.sendBeacon("/close");
    } catch (error) {
      fetch("/close", { keepalive: true }).catch(() => {});
    }
  }

  // Close the popup window
  function requestWindowClose() {
    if (window.snooply && typeof window.snooply.requestClose === "function") {
      window.snooply.requestClose();
      return;
    }

    // Fallback for a plain browser tab (no Electron bridge)
    try {
      window.close();
    } catch (error) {
      // Browser may refuse this - the CLI has already exited anyway
    }
  }

  // Handle popup dragging
  // (native drag-region swallowed button clicks, so we do it by hand)
  function isInteractiveTarget(target) {
    return !!(target && target.closest && target.closest("button, a"));
  }

  function handleCardMouseDown(event) {
    if (!window.snooply || typeof window.snooply.moveBy !== "function") {
      return;
    }
    if (event.button !== 0 || isInteractiveTarget(event.target)) {
      return;
    }

    event.preventDefault();
    let lastX = event.screenX;
    let lastY = event.screenY;
    event.currentTarget.classList.add("dragging");

    function onMove(e) {
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      if (dx !== 0 || dy !== 0) {
        window.snooply.moveBy(dx, dy);
      }
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      event.currentTarget.classList.remove("dragging");
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startHeartbeat() {
    const ping = () => fetch("/ping").catch(() => {});
    ping();
    const timer = setInterval(ping, 2000);
    window.addEventListener("beforeunload", () => {
      clearInterval(timer);
      closeServer();
    });
  }

  // Turn `backtick` text into inline code
  function renderWithCode(text, keyPrefix) {
    const parts = String(text).split("`");
    return parts.map((part, i) => (i % 2 === 1 ? h("code", { key: keyPrefix + i }, part) : part));
  }

  // Part 7 tags cross-workspace names like "axios (client)" - strip that
  // back off for anything that has to be real, like an npm command.
  function baseDependencyName(name) {
    return String(name).replace(/\s\([^)]+\)$/, "");
  }

  // Two-letter monogram for a package, no icon library needed
  function iconLettersFor(name) {
    const base = baseDependencyName(name);
    const last = base.includes("/") ? base.split("/").pop() : base;
    return last.slice(0, 2).toLowerCase();
  }

  function CloseButton(props) {
    return h(
      "button",
      { className: "close-btn", onClick: props.onClose, "aria-label": "Close" },
      h(
        "svg",
        { width: 12, height: 12, viewBox: "0 0 14 14", fill: "none" },
        h("path", { d: "M1 1L13 13M13 1L1 13", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" })
      )
    );
  }

  // Three small dots to hint the card is draggable
  function DragDots() {
    return h(
      "div",
      { className: "drag-dots", "aria-hidden": "true" },
      h("span", null),
      h("span", null),
      h("span", null)
    );
  }

  function badgeFor(item) {
    return item.kind === "UNUSED" ? { text: "Unused", cls: "unused" } : { text: "Worth a look", cls: "look" };
  }

  function Badge(props) {
    const badge = badgeFor(props.item);
    return h("span", { className: "badge " + badge.cls }, h("span", { className: "dot" }), badge.text);
  }

  // Show one recommendation card
  function RecommendationCard(props) {
    const item = props.item;
    const hasUsage = item.used && item.used.length > 0;
    const isUnused = item.kind === "UNUSED";

    return h(
      "div",
      { className: "rec-card" },
      h(
        "div",
        { className: "rec-top" },
        h("span", { className: "rec-icon" }, iconLettersFor(item.dependency)),
        h("span", { className: "rec-name" }, item.dependency),
        h(Badge, { item })
      ),
      hasUsage
        ? h(
            React.Fragment,
            null,
            h("p", { className: "usage-label" }, "You're only using:"),
            h(
              "ul",
              { className: "usage-list" },
              item.used.map((fn, i) => h("li", { key: fn + i }, h("span", { className: "tick" }, "✓"), fn))
            )
          )
        : h("p", { className: "usage-label" }, item.reason),
      h(
        "p",
        { className: "suggestion" },
        renderWithCode(item.suggestion, "s" + item.dependency)
      ),
      h(
        "div",
        { className: "card-actions" + (isUnused ? "" : " only-explore") },
        isUnused &&
          h("code", { className: "uninstall-pill" }, `npm uninstall ${baseDependencyName(item.dependency)}`),
        h("button", { className: "explore-btn", onClick: () => props.onExplore(item) }, "Explore", h("span", null, "→"))
      )
    );
  }

  // Button that copies text to the clipboard, briefly says "Copied"
  function CopyCommandButton(props) {
    const [copied, setCopied] = React.useState(false);

    function handleCopy() {
      navigator.clipboard
        .writeText(props.command)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {});
    }

    return h(
      "button",
      { className: "copy-btn", onClick: handleCopy },
      copied ? "Copied" : "Copy command"
    );
  }

  // Show the full evidence Snooply has for one dependency - why it was
  // flagged, where it was found, what was actually checked, and what
  // to do next. Everything here comes from the analyzer's own output;
  // this view only presents it.
  // One labeled command line: a pill with the command plus a copy button
  function CommandRow(props) {
    return h(
      "div",
      { className: "action-row" },
      h("code", { className: "uninstall-pill", style: { flex: "1 1 auto" } }, props.command),
      h(CopyCommandButton, { command: props.command })
    );
  }

  function ExploreView(props) {
    const item = props.item;
    const isUnused = item.kind === "UNUSED";
    const where = item.where || [];
    const baseName = baseDependencyName(item.dependency);
    const uninstallCommand = `npm uninstall ${baseName}`;
    const installCommand = item.suggestedPackages && item.suggestedPackages.length > 0
      ? `npm install ${item.suggestedPackages.join(" ")}`
      : null;

    return h(
      "div",
      null,
      h("button", { className: "back-btn", onClick: props.onBack }, "← Back"),
      h(
        "div",
        { className: "rec-top", style: { marginTop: 8 } },
        h("span", { className: "rec-icon" }, iconLettersFor(item.dependency)),
        h("span", { className: "rec-name", style: { fontSize: 16 } }, item.dependency),
        h(Badge, { item })
      ),

      h("p", { className: "detail-label" }, "Why Snooply flagged this"),
      h("p", { className: "detail-text" }, item.reason),

      h("p", { className: "detail-label" }, "Where it was found"),
      where.length > 0
        ? h(
            "ul",
            { className: "where-list" },
            where.map((entry, i) =>
              h(
                "li",
                { key: entry.file + i, className: "where-row" },
                h("span", { className: "where-file" }, entry.file),
                entry.used && h("span", { className: "where-used" }, entry.used)
              )
            )
          )
        : h("p", { className: "detail-text muted" }, "No usage found."),

      h("p", { className: "detail-label" }, "What Snooply checked"),
      h(
        "ul",
        { className: "checked-list" },
        h("li", null, `${item.filesChecked} source file${item.filesChecked === 1 ? "" : "s"} scanned (.js / .jsx)`),
        h(
          "li",
          null,
          `${item.dependenciesChecked} dependenc${item.dependenciesChecked === 1 ? "y" : "ies"} checked against package.json: `,
          h("span", { className: "checked-deps" }, (item.dependenciesList || []).join(", "))
        ),
        h("li", null, "Usage detected via imports, requires, and member access (e.g. ", h("code", null, "pkg.method()"), ")")
      ),

      h("p", { className: "detail-label" }, "Recommendation"),
      h("p", { className: "detail-text" }, renderWithCode(item.suggestion, "d" + item.dependency)),

      h("p", { className: "detail-label" }, "Action"),
      isUnused
        ? h(CommandRow, { command: uninstallCommand })
        : h(
            React.Fragment,
            null,
            installCommand &&
              h(
                React.Fragment,
                null,
                h("p", { className: "action-step" }, "1. Install the alternative"),
                h(CommandRow, { command: installCommand })
              ),
            where.length > 0 &&
              h(
                React.Fragment,
                null,
                h("p", { className: "action-step" }, `2. Update where ${item.used ? item.used.join(", ") : "it"} is used`),
                h(
                  "ul",
                  { className: "where-list" },
                  where.map((entry, i) =>
                    h(
                      "li",
                      { key: "u" + entry.file + i, className: "where-row" },
                      h("span", { className: "where-file" }, entry.file),
                      entry.used && h("span", { className: "where-used" }, entry.used)
                    )
                  )
                )
              ),
            h("p", { className: "action-step" }, "3. Remove the old package once nothing else uses it"),
            h(CommandRow, { command: uninstallCommand })
          )
    );
  }

  // Show every dependency and its usage
  function AllDependenciesView(props) {
    return h(
      "div",
      null,
      h("button", { className: "back-btn", onClick: props.onBack }, "← Back"),
      h("p", { className: "headline", style: { fontSize: 15, marginTop: 8, textAlign: "left" } }, "All dependencies"),
      h(
        "div",
        { className: "deps-list" },
        props.dependencies.map((dep) => {
          const used = props.usage[dep] || [];
          return h(
            "div",
            { className: "dep-row", key: dep },
            h("span", { className: "dep-name" }, dep),
            h("span", { className: "dep-usage" }, used.length ? used.join(", ") : "not detected")
          );
        })
      )
    );
  }

  // "See all dependencies" row, shared by the list and empty states
  function SeeAllRow(props) {
    return h(
      "button",
      { className: "see-all", onClick: props.onSeeAll },
      h(
        "svg",
        { className: "see-all-icon", width: 14, height: 14, viewBox: "0 0 16 16", fill: "none" },
        h("rect", { x: 1, y: 1, width: 6, height: 6, rx: 1.5, stroke: "currentColor", strokeWidth: 1.3 }),
        h("rect", { x: 9, y: 1, width: 6, height: 6, rx: 1.5, stroke: "currentColor", strokeWidth: 1.3 }),
        h("rect", { x: 1, y: 9, width: 6, height: 6, rx: 1.5, stroke: "currentColor", strokeWidth: 1.3 }),
        h("rect", { x: 9, y: 9, width: 6, height: 6, rx: 1.5, stroke: "currentColor", strokeWidth: 1.3 })
      ),
      h("span", { className: "see-all-label" }, "See all dependencies"),
      h("span", { className: "see-all-arrow" }, "›")
    );
  }

  // Small info line at the bottom of the popup
  function Footer(props) {
    return h(
      "div",
      { className: "footer" },
      h("span", null, "ⓘ Keep what you use. Lose the rest."),
      props.version && h("span", null, `v${props.version}`)
    );
  }

  // Show empty state (nothing found)
  function EmptyState(props) {
    return h(
      "div",
      { className: "empty-state" },
      h("p", { className: "headline" }, "Snooply took a little look…"),
      h("p", { className: "subhead" }, "Everything looks pretty reasonable! ♡"),
      h("p", { className: "subhead-2" }, "Nothing worth bothering you about right now."),
      h(SeeAllRow, { onSeeAll: props.onSeeAll }),
      h(Footer, { version: props.version })
    );
  }

  // --- Verbose popup ---
  // Same analysis result as normal mode, just shown in more detail.
  // The CLI only sends this extra data when run with --verbose.

  function VerboseBadge() {
    return h("span", { className: "verbose-badge" }, "VERBOSE");
  }

  // One dependency's usage - click to expand its file list
  function DependencyUsageRow(props) {
    const entry = props.entry;
    const [open, setOpen] = React.useState(false);
    const count = entry.files.length;

    return h(
      "div",
      { className: "usage-row" },
      h(
        "button",
        { className: "usage-row-head", onClick: () => setOpen(!open), "aria-expanded": open },
        h("span", { className: "usage-row-name" }, entry.dependency),
        h(
          "span",
          { className: "usage-row-meta" },
          `${count} file${count === 1 ? "" : "s"}`,
          h("span", { className: "usage-row-caret" }, open ? "⌄" : "›")
        )
      ),
      open &&
        (count > 0
          ? h(
              "ul",
              { className: "usage-row-files" },
              entry.files.map((file, i) => h("li", { key: file + i }, file))
            )
          : h("p", { className: "usage-row-empty" }, "No usage found."))
    );
  }

  function ProjectOverview(props) {
    const packages = props.packages;
    const single = packages.length <= 1;

    return h(
      "div",
      { className: "verbose-section" },
      h("p", { className: "detail-label" }, "Project"),
      h("p", { className: "project-name" }, `${props.project}/`),
      single
        ? h(
            "div",
            { className: "overview-stats" },
            h(
              "div",
              { className: "stat" },
              h("span", { className: "stat-label" }, "Dependencies"),
              h("span", { className: "stat-value" }, packages[0] ? packages[0].dependencies : 0)
            ),
            h(
              "div",
              { className: "stat" },
              h("span", { className: "stat-label" }, "Source files"),
              h("span", { className: "stat-value" }, packages[0] ? packages[0].files : 0)
            )
          )
        : h(
            "div",
            { className: "deps-list" },
            packages.map((pkg) =>
              h(
                "div",
                { className: "dep-row", key: pkg.label },
                h("span", { className: "dep-name" }, `${pkg.label}/`),
                h("span", { className: "dep-usage" }, `${pkg.dependencies} deps · ${pkg.files} files`)
              )
            )
          )
    );
  }

  // The deeper "verbose" home screen - project overview, every
  // dependency's usage, then the same recommendation cards as normal mode
  function VerboseHome(props) {
    const data = props.data;
    const items = data.items || [];
    const dependencyUsage = data.dependencyUsage || [];

    return h(
      React.Fragment,
      null,
      h(
        "div",
        { className: "verbose-header" },
        h("p", { className: "brand-title", style: { margin: 0 } }, "Snooply"),
        h(VerboseBadge, null)
      ),
      h("p", { className: "brand-subhead" }, "A closer look at your project."),

      h(ProjectOverview, { project: data.project, packages: data.packages || [] }),

      h(
        "div",
        { className: "verbose-section" },
        h("p", { className: "detail-label" }, "Dependency usage"),
        h(
          "div",
          { className: "usage-list-scroll" },
          dependencyUsage.map((entry, i) => h(DependencyUsageRow, { key: entry.dependency + i, entry }))
        )
      ),

      h(
        "div",
        { className: "verbose-section" },
        h(
          "div",
          { className: "section-label-row" },
          h("p", { className: "detail-label", style: { margin: 0 } }, "Recommendations"),
          items.length > 0 && h("span", { className: "section-count" }, items.length)
        ),
        items.length === 0
          ? h("p", { className: "detail-text muted" }, "♡ Nothing flagged. Everything looks pretty reasonable.")
          : h(
              "div",
              { className: "card-list" },
              items.map((item, i) => h(RecommendationCard, { key: item.dependency + i, item, onExplore: props.onExplore }))
            )
      ),

      h(Footer, { version: data.version })
    );
  }

  // Popup frame - background glow, fixed-size card, drag handling
  // The card's size never changes; whatever view is showing scrolls
  // inside it instead of the window growing or shrinking.
  function Shell(props) {
    return h(
      React.Fragment,
      null,
      h("div", { className: "bg-glow a" }),
      h("div", { className: "bg-glow b" }),
      h("div", { className: "bg-glow c" }),
      h(
        "div",
        { className: "app" },
        h(
          "div",
          { className: "popup-card", onMouseDown: handleCardMouseDown },
          h(DragDots, null),
          props.closeButton,
          h("div", { className: "popup-scroll" }, props.children)
        )
      )
    );
  }

  function App(props) {
    const data = props.data;
    const items = data.items || [];
    const [view, setView] = React.useState("list"); // list | explore | all | closed
    const [selected, setSelected] = React.useState(null);

    React.useEffect(() => {
      startHeartbeat();
    }, []);

    function handleClose() {
      setView("closed");
      closeServer();
      setTimeout(requestWindowClose, 250);
    }

    const closeButton = h(CloseButton, { onClose: handleClose });

    if (view === "closed") {
      return h(
        Shell,
        { closeButton },
        h(
          "div",
          { className: "empty-state" },
          h("p", { className: "headline" }, "See you soon"),
          h("p", { className: "subhead" }, "You can close this window now.")
        )
      );
    }

    // Pick which view to show
    let body;

    const goExplore = (it) => {
      setSelected(it);
      setView("explore");
    };

    if (view === "explore" && selected) {
      body = h(ExploreView, { item: selected, onBack: () => setView("list") });
    } else if (view === "all") {
      body = h(AllDependenciesView, { dependencies: data.dependencies, usage: data.usage, onBack: () => setView("list") });
    } else if (data.verbose) {
      body = h(VerboseHome, { data, onExplore: goExplore });
    } else if (items.length === 0) {
      body = h(EmptyState, { onSeeAll: () => setView("all"), version: data.version });
    } else {
      const noun = items.length === 1 ? "thing" : "things";
      body = h(
        React.Fragment,
        null,
        h("p", { className: "brand-title" }, "Snooply"),
        h("p", { className: "brand-subhead" }, "A cleaner project starts here."),
        h("p", { className: "finding-count" }, `Found ${items.length} ${noun} worth checking.`),
        h(
          "div",
          { className: "card-list" },
          items.map((item, i) =>
            h(RecommendationCard, { key: item.dependency + i, item, onExplore: goExplore })
          )
        ),
        h(SeeAllRow, { onSeeAll: () => setView("all") }),
        h(Footer, { version: data.version })
      );
    }

    return h(Shell, { closeButton }, body);
  }

  const data = getData();
  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(h(App, { data }));
})();
