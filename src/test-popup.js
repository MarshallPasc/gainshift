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
    tagName: tag, id: id || "", value: "", textContent: "",
    children: [], listeners: {}, dataset: {}, className: "",
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
  return el;
}

function makeEnv(stored, opts = {}) {
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
        sentTypes.push(m.type);
        if (m.type === "lookupVolume") return stored;
        if (m.type === "storeVolume") return { ok: true, host: "site.example", remembered: true };
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

  return {
    els, presets, sentTypes,
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

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
