/* Test harness for popup.js — what the panel shows for a given stored level.
 *
 * Same approach as the other two suites: the real source is run in a fresh VM
 * context against a mock, with no dependencies beyond Node itself. The mock DOM
 * here is deliberately tiny — just enough of the surface popup.js touches.
 *
 * What it does NOT cover: the CSS that turns the `muted` class into a visible
 * mute mark. A stylesheet needs a layout engine to assert against. The class is
 * the contract between popup.js and popup.css, so that is what is pinned here.
 */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok    ${name}  (${JSON.stringify(got)})`); }
  else { fail++; console.log(`  FAIL  ${name}  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

/* ---------- a very small DOM ---------- */

function makeEl(tag, id) {
  const classes = new Set();
  const el = {
    tagName: tag, id: id || "", value: "",
    children: [], listeners: {}, dataset: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    _classes: classes,
    addEventListener: (k, f) => { (el.listeners[k] = el.listeners[k] || []).push(f); },
    append: (...xs) => { el.children.push(...xs); },
    blur: () => {},
    select: () => {},
  };
  // Writing textContent throws away the children — that is how popup.js empties
  // the site row and the status line before redrawing them. A mock that kept the
  // old children would let a stale node answer a query and hide a real bug.
  let text = "";
  Object.defineProperty(el, "textContent", {
    enumerable: true,
    get: () => text,
    set: (v) => { text = v == null ? "" : String(v); el.children.length = 0; },
  });

  // A real element keeps `className` and `classList` looking at the same set of
  // classes. popup.js writes one and reads the other (node() assigns className,
  // paint() calls classList.toggle), so the mock has to do the same or a test
  // can pass against code that would be broken in the browser.
  Object.defineProperty(el, "className", {
    enumerable: true,
    get: () => [...classes].join(" "),
    set: (v) => {
      classes.clear();
      String(v == null ? "" : v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
  });
  return el;
}

function makeEnv(stored, opts = {}) {
  let siteLevel = typeof stored.siteValue === "number" ? stored.siteValue : null;
  const els = {
    slider: makeEl("input", "slider"),
    entry: makeEl("input", "entry"),
    status: makeEl("div", "status"),
    frames: makeEl("div", "frames"),
    site: makeEl("div", "site"),
  };
  const presets = [0, 25, 50, 100, 200].map((v) => {
    const b = makeEl("button");
    b.dataset.v = String(v);
    return b;
  });

  const sent = [];
  const sentTypes = [];
  const document = {
    getElementById: (id) => els[id] || null,
    querySelectorAll: (sel) => (sel === ".presets button" ? presets : []),
    createElement: (t) => makeEl(t),
  };

  const browser = {
    tabs: { query: async () => (opts.noTab ? [] : [{ id: 7 }]) },
    runtime: {
      sendMessage: async (m) => {
        sent.push(m);
        sentTypes.push(m.type);
        if (m.type === "lookupVolume") return stored;
        if (m.type === "storeVolume") {
          // Mirror the background page: a tab-scoped write leaves the site
          // entry exactly as it was, a site-scoped one replaces it.
          const scope = m.scope === "tab" ? "tab" : "site";
          if (scope === "site") siteLevel = m.value === 1 ? null : m.value;
          return {
            ok: true,
            host: stored.host,
            scope,
            remembered: siteLevel !== null,
            siteValue: siteLevel
          };
        }
        if (m.type === "fanOut") {
          return [{ frameId: 0, url: "https://site.example/", ok: true,
                    state: { mediaCount: 1, audioContexts: 0, hookAlive: true } }];
        }
        return {};
      },
    },
  };

  const ctx = {
    browser, chrome: browser, document, console,
    window: { addEventListener: () => {} },
    URL, setTimeout, clearTimeout, Promise, JSON, Object, Math, Array, Number, String,
    isNaN, parseInt, parseFloat,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const kids = (el) => el.children;
  const scopeRow = () => kids(els.site).find((c) => c.className === "scope");
  // append() takes raw strings as well as elements ("Saved for ", then a <b>),
  // so the walk has to cope with a child that has no children of its own.
  // Children are joined with a space because the row lays them out with a flex
  // `gap`, so that is what the eye sees between them.
  const textOf = (el) =>
    typeof el === "string" ? el
      : (el.textContent || "") + (el.children || []).map(textOf).join(" ");

  return {
    els, presets, sentTypes, sent,
    // The scope control, as the user sees it.
    scopeButtons: () => (scopeRow() ? kids(scopeRow()) : []),
    activeScope: () => {
      const b = (scopeRow() ? kids(scopeRow()) : []).find((x) => x._classes.has("on"));
      return b ? b.textContent : null;
    },
    clickScope: (label) => {
      const b = kids(scopeRow()).find((x) => x.textContent === label);
      b.listeners.click.forEach((f) => f());
    },
    siteText: () => kids(els.site).map(textOf).join(" ").replace(/\s+/g, " ").trim(),
    levelText: () => {
      const name = kids(els.site).find((c) => c.className === "name");
      const lvl = name && kids(name).find((c) => c.className === "lvl");
      return lvl ? lvl.textContent : null;
    },
    hasForget: () => kids(els.site).some((c) => c.className === "forget"),
    lastStore: () => [...sent].reverse().find((m) => m.type === "storeVolume") || null,
    // What the user sees in the box, and the class the stylesheet keys off.
    shown: () => els.entry.value,
    muted: () => els.entry._classes.has("muted"),
    boost: () => els.entry._classes.has("boost"),
    slider: () => els.slider.value,
    activePreset: () => presets.filter((b) => b._classes.has("active")).map((b) => b.dataset.v),
    press: (v) => {
      const b = presets.find((x) => x.dataset.v === String(v));
      b.listeners.click.forEach((f) => f());
    },
    type: (v) => {
      els.entry.value = String(v);
      els.entry.listeners.input.forEach((f) => f());
    },
    commit: (v) => {
      els.entry.value = String(v);
      els.entry.listeners.change.forEach((f) => f());
    },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("\n1. A site muted at 0 opens showing 0, not 100");
  {
    // The failure this pins: `stored.value || 1`. Zero is falsy, so a muted site
    // reported itself as 100% — the panel disagreed with the audio, and the
    // first slider nudge silently unmuted the site.
    const t = makeEnv({ value: 0, host: "site.example", remembered: true });
    await wait(20);
    eq("shows 0", t.shown(), "0");
    eq("slider agrees", t.slider(), "0");
    eq("marked muted for the stylesheet", t.muted(), true);
    eq("not marked boost", t.boost(), false);
  }

  console.log("\n2. Other stored levels still open correctly");
  {
    const t = makeEnv({ value: 0.45, host: "site.example", remembered: true });
    await wait(20);
    eq("shows 45", t.shown(), "45");
    eq("not muted", t.muted(), false);
  }
  {
    const t = makeEnv({ value: 2.5, host: "site.example", remembered: true });
    await wait(20);
    eq("shows 250", t.shown(), "250");
    eq("marked boost", t.boost(), true);
    eq("not muted", t.muted(), false);
  }
  {
    // Nothing stored at all: the reply carries no number, so 100 is the default.
    const t = makeEnv({ value: undefined, host: null, remembered: false });
    await wait(20);
    eq("defaults to 100", t.shown(), "100");
    eq("not muted", t.muted(), false);
  }

  console.log("\n3. The muted mark appears at 0 and nowhere else");
  {
    const t = makeEnv({ value: 1, host: "site.example", remembered: false });
    await wait(20);
    eq("100% is not muted", t.muted(), false);
    t.press(0);
    eq("0 preset mutes", t.muted(), true);
    t.press(25);
    eq("leaving 0 un-mutes", t.muted(), false);
    t.press(0);
    eq("back to 0 mutes again", t.muted(), true);
    t.commit(1);
    eq("1% is not muted", t.muted(), false);
    eq("1% is shown as 1", t.shown(), "1");
  }

  console.log("\n4. Typed input is clamped and classified");
  {
    const t = makeEnv({ value: 1, host: "site.example", remembered: false });
    await wait(20);
    t.commit(9999);
    eq("clamped to the maximum", t.shown(), "600");
    eq("maximum is a boost", t.boost(), true);
    t.commit(-40);
    eq("clamped to zero", t.shown(), "0");
    eq("clamped zero counts as muted", t.muted(), true);
    t.commit("abc");
    eq("garbage keeps the last value", t.shown(), "0");
  }

  console.log("\n5. The active preset tracks the value");
  {
    const t = makeEnv({ value: 1, host: "site.example", remembered: false });
    await wait(20);
    eq("100 is active at rest", t.activePreset(), ["100"]);
    t.press(0);
    eq("0 is active when muted", t.activePreset(), ["0"]);
    t.type(137);
    eq("no preset matches 137", t.activePreset(), []);
  }


  console.log("\n6. The scope control shows which of the two you are in");
  {
    const t = makeEnv({ value: 0.45, host: "youtube.com", remembered: true,
                        scope: "site", siteValue: 0.45 });
    await wait(20);
    eq("both choices are always offered", t.scopeButtons().map((b) => b.textContent), ["Tab", "Site"]);
    eq("site is the default", t.activeScope(), "Site");
    eq("and it reads as saved", t.siteText().includes("Saved for youtube.com"), true);
    eq("Forget is offered", t.hasForget(), true);
  }
  {
    const t = makeEnv({ value: 1, host: "fresh.example", remembered: false,
                        scope: "site", siteValue: null });
    await wait(20);
    eq("an unsaved site says so", t.siteText().includes("Applies to fresh.example"), true);
    eq("and offers no Forget", t.hasForget(), false);
  }

  console.log("\n7. Choosing Tab keeps the site's level visible");
  {
    // The point of the label: while the tab is held apart, you can still see
    // what the site itself would do, so it is obvious which is the exception.
    const t = makeEnv({ value: 0.9, host: "youtube.com", remembered: true,
                        scope: "tab", siteValue: 0.45 });
    await wait(20);
    eq("opens in tab scope", t.activeScope(), "Tab");
    eq("names the site's own level", t.siteText().includes("youtube.com keeps 45%"), true);
    // The level has to be its own element: the stylesheet lets the hostname
    // shorten on a narrow row and pins this, and a rendered check caught the
    // level being ellipsised away when the two shared one text node.
    eq("the level is a separate element the CSS can protect", t.levelText(), "keeps 45%");
  }
  {
    const t = makeEnv({ value: 0.3, host: "rainbet.com", remembered: false,
                        scope: "tab", siteValue: null });
    await wait(20);
    eq("with nothing saved it says unsaved", t.siteText().includes("rainbet.com unsaved"), true);
  }

  console.log("\n8. Switching to Tab stops writing to the site");
  {
    const t = makeEnv({ value: 0.5, host: "youtube.com", remembered: true,
                        scope: "site", siteValue: 0.5 });
    await wait(20);

    t.press(25);                       // a site-scoped change, as today
    await wait(40);
    eq("sent with site scope", t.lastStore().scope, "site");

    t.clickScope("Tab");
    await wait(40);
    eq("the control follows", t.activeScope(), "Tab");
    eq("and the next write is tab-scoped", t.lastStore().scope, "tab");
    eq("at the level already showing", t.lastStore().value, 0.25);

    t.commit(60);                      // 60 is not a preset, so use the box
    await wait(40);
    eq("later changes stay tab-scoped", t.lastStore().scope, "tab");
    eq("...carrying the new value", t.lastStore().value, 0.6);
  }

  console.log("\n9. Switching back to Site writes it to the site again");
  {
    const t = makeEnv({ value: 0.5, host: "youtube.com", remembered: true,
                        scope: "tab", siteValue: 0.5 });
    await wait(20);
    eq("starts in tab scope", t.activeScope(), "Tab");
    t.commit(30);
    await wait(40);
    eq("tab-scoped while it lasts", t.lastStore().scope, "tab");

    t.clickScope("Site");
    await wait(40);
    eq("now site-scoped", t.lastStore().scope, "site");
    eq("carrying what was on screen", t.lastStore().value, 0.3);
    eq("the control agrees", t.activeScope(), "Site");
  }

  console.log("\n10. Clicking the scope you are already in changes nothing");
  {
    const t = makeEnv({ value: 0.5, host: "youtube.com", remembered: true,
                        scope: "site", siteValue: 0.5 });
    await wait(20);
    const before = t.sent.length;
    t.clickScope("Site");
    await wait(40);
    eq("no message sent", t.sent.length, before);
    eq("still site", t.activeScope(), "Site");
  }

  console.log("\n11. A tab with no host has no scope control to offer");
  {
    const t = makeEnv({ value: 1, host: null, remembered: false, scope: "site", siteValue: null });
    await wait(20);
    eq("nothing rendered", t.scopeButtons(), []);
    eq("the row is empty", t.siteText(), "");
  }

  console.log("\n12. Forget is not undone by a save still waiting to go out");
  {
    // Drag, then click Forget before the 350ms save debounce fires. The queued
    // save used to land after Forget and store the dragged level right back.
    const t = makeEnv({ value: 0.45, host: "youtube.com", remembered: true,
                        scope: "site", siteValue: 0.45 });
    await wait(20);
    t.els.slider.value = "150";
    t.els.slider.listeners.input.forEach((f) => f());
    await wait(100);                   // the apply has gone out, the save has not
    const forget = t.els.site.children.find((c) => c.className === "forget");
    forget.listeners.click.forEach((f) => f());
    await wait(500);

    const afterForget = t.sentTypes.slice(t.sentTypes.indexOf("forgetSite"));
    eq("nothing is saved after Forget", afterForget.includes("storeVolume"), false);
    eq("the panel shows 100", t.shown(), "100");
    eq("and no longer claims a saved level", t.siteText().includes("Saved for"), false);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
