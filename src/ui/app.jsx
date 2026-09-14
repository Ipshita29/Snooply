(function () {
  const h = React.createElement;

  function getData() {
    const el = document.getElementById("snooply-data");
    try {
      return JSON.parse(el.textContent);
    } catch (error) {
      return { items: [], dependencies: [], usage: {} };
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

  function reportSize(el) {
    if (!el || !window.snooply || typeof window.snooply.resize !== "function") {
      return;
    }
    const height = Math.ceil(el.getBoundingClientRect().height) + 28; // + .app padding
    window.snooply.resize(height);
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

  // Show the mascot
  function Mascot(props) {
    const size = (props && props.size) || 60;
    return h(
      "svg",
      { className: "mascot", width: size, height: size, viewBox: "0 0 64 64", fill: "none" },
      h(
        "defs",
        null,
        h(
          "linearGradient",
          { id: "mascotHead", x1: "0", y1: "0", x2: "0", y2: "1" },
          h("stop", { offset: "0%", stopColor: "#ffffff" }),
          h("stop", { offset: "100%", stopColor: "#dfe3f0" })
        ),
        h(
          "linearGradient",
          { id: "mascotEar", x1: "0", y1: "0", x2: "0", y2: "1" },
          h("stop", { offset: "0%", stopColor: "#eef0f7" }),
          h("stop", { offset: "100%", stopColor: "#c7cce0" })
        )
      ),
      // floppy ears
      h("ellipse", { cx: 14, cy: 30, rx: 8.5, ry: 13, fill: "url(#mascotEar)", transform: "rotate(-24 14 30)" }),
      h("ellipse", { cx: 50, cy: 30, rx: 8.5, ry: 13, fill: "url(#mascotEar)", transform: "rotate(24 50 30)" }),
      // head
      h("circle", { cx: 32, cy: 35, r: 19, fill: "url(#mascotHead)" }),
      // blush
      h("ellipse", { cx: 21, cy: 41, rx: 3.2, ry: 2.2, fill: "#f9a8d4", opacity: 0.45 }),
      h("ellipse", { cx: 43, cy: 41, rx: 3.2, ry: 2.2, fill: "#f9a8d4", opacity: 0.45 }),
      // eyes + nose
      h("circle", { cx: 25, cy: 33, r: 2.4, fill: "#12162a" }),
      h("circle", { cx: 39, cy: 33, r: 2.4, fill: "#12162a" }),
      h("ellipse", { cx: 32, cy: 41, rx: 3, ry: 2.2, fill: "#12162a" })
    );
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

  function badgeFor(item) {
    return item.kind === "UNUSED" ? { text: "Unused", cls: "unused" } : { text: "Worth a look", cls: "look" };
  }

  // Show one recommendation card
  function RecommendationCard(props) {
    const item = props.item;
    const badge = badgeFor(item);
    const hasUsage = item.used && item.used.length > 0;

    return h(
      "div",
      { className: "rec-card" },
      h(
        "div",
        { className: "rec-top" },
        h("span", { className: "rec-name" }, item.dependency),
        h("span", { className: "badge " + badge.cls }, badge.text)
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
        h("span", null, "💡"),
        h("span", null, renderWithCode(item.suggestion, "s" + item.dependency))
      ),
      h(
        "div",
        { className: "card-actions" },
        h("button", { className: "explore-btn", onClick: () => props.onExplore(item) }, "Explore", h("span", null, "→"))
      )
    );
  }

  // Show the full details for one dependency
  function ExploreView(props) {
    const item = props.item;
    const badge = badgeFor(item);
    const hasUsage = item.used && item.used.length > 0;

    return h(
      "div",
      null,
      h("button", { className: "back-btn", onClick: props.onBack }, "← Back"),
      h(
        "div",
        { className: "rec-top", style: { marginTop: 8 } },
        h("span", { className: "rec-name", style: { fontSize: 17 } }, item.dependency),
        h("span", { className: "badge " + badge.cls }, badge.text)
      ),
      hasUsage &&
        h(
          React.Fragment,
          null,
          h("p", { className: "usage-label" }, "You're only using:"),
          h(
            "ul",
            { className: "usage-list" },
            item.used.map((fn, i) => h("li", { key: fn + i }, h("span", { className: "tick" }, "✓"), fn))
          )
        ),
      h("p", { className: "detail-label" }, "Why Snooply noticed"),
      h("p", { className: "detail-text" }, item.reason),
      h("p", { className: "detail-label" }, "Suggestion"),
      h("p", { className: "detail-text" }, renderWithCode(item.suggestion, "d" + item.dependency))
    );
  }

  // Show every dependency and its usage
  function AllDependenciesView(props) {
    return h(
      "div",
      null,
      h("button", { className: "back-btn", onClick: props.onBack }, "← Back"),
      h("p", { className: "headline", style: { fontSize: 16, marginTop: 8, textAlign: "left" } }, "All dependencies"),
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

  // Show empty state (nothing found)
  function EmptyState(props) {
    return h(
      "div",
      { className: "empty-state" },
      h("div", { className: "mascot-wrap" }, h(Mascot, null)),
      h("p", { className: "headline" }, "Snooply took a little look…"),
      h("p", { className: "subhead" }, "Everything looks pretty reasonable! ♡"),
      h("p", { className: "subhead-2" }, "Nothing worth bothering you about right now."),
      h("button", { className: "see-all", onClick: props.onSeeAll }, "See all dependencies →")
    );
  }

  // Popup frame - background glow, card, drag handling
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
        h("div", { className: "popup-card", ref: props.cardRef, onMouseDown: handleCardMouseDown }, props.children)
      )
    );
  }

  function App(props) {
    const data = props.data;
    const items = data.items || [];
    const [view, setView] = React.useState("list"); // list | explore | all | closed
    const [selected, setSelected] = React.useState(null);
    const cardRef = React.useRef(null);

    React.useEffect(() => {
      startHeartbeat();
    }, []);

    // Resize the window to fit whatever view is showing
    React.useEffect(() => {
      if (!cardRef.current || typeof ResizeObserver === "undefined") {
        return;
      }
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          reportSize(entry.target);
        }
      });
      observer.observe(cardRef.current);
      reportSize(cardRef.current);
      return () => observer.disconnect();
    }, [view, selected]);

    function handleClose() {
      setView("closed");
      closeServer();
      setTimeout(requestWindowClose, 250);
    }

    if (view === "closed") {
      return h(
        Shell,
        { cardRef },
        h(CloseButton, { onClose: handleClose }),
        h("div", { className: "empty-state" },
          h("div", { className: "mascot-wrap" }, h(Mascot, { size: 48 })),
          h("p", { className: "headline" }, "See you soon! 🐾"),
          h("p", { className: "subhead" }, "You can close this window now.")
        )
      );
    }

    // Pick which view to show
    let body;

    if (view === "explore" && selected) {
      body = h(ExploreView, { item: selected, onBack: () => setView("list") });
    } else if (view === "all") {
      body = h(AllDependenciesView, { dependencies: data.dependencies, usage: data.usage, onBack: () => setView("list") });
    } else if (items.length === 0) {
      body = h(EmptyState, { onSeeAll: () => setView("all") });
    } else {
      body = h(
        React.Fragment,
        null,
        h("div", { className: "mascot-wrap" }, h(Mascot, null)),
        h("p", { className: "headline" }, items.length === 1 ? "Snooply found something!" : `Snooply found ${items.length} things!`),
        h("p", { className: "subhead" }, "I think these are worth a look 👀"),
        h(
          "div",
          { className: "card-list" },
          items.map((item, i) =>
            h(RecommendationCard, {
              key: item.dependency + i,
              item,
              onExplore: (it) => {
                setSelected(it);
                setView("explore");
              },
            })
          )
        ),
        h("button", { className: "see-all", onClick: () => setView("all") }, "See all dependencies →")
      );
    }

    return h(Shell, { cardRef }, h(CloseButton, { onClose: handleClose }), body);
  }

  const data = getData();
  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(h(App, { data }));
})();
