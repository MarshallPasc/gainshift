/* Test harness for content.js — the isolated-world relay.
 *
 * Small, but it covers the one place page-controlled data crosses out of the
 * page: the data-gainshift-* attributes live in the page's own DOM, so a hostile
 * page can write them too. Everything this file hands to the popup is therefore
 * untrusted input, and that is what these tests are about.
 *
 * Same approach as the other suites: the real source, a fresh VM context, a mock,
 * and no dependencies beyond Node.
 */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "content.js"), "utf8");

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok    ${name}  (${JSON.stringify(got)})`); }
  else { fail++; console.log(`  FAIL  ${name}  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

function makeEnv(attrs = {}, mediaElements = 0, opts = {}) {
  const queries = { n: 0 };
  let onMessage = null;
  let releaseStartup = null;
  const startup = new Promise((res) => { releaseStartup = res; });

  const documentElement = {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
  };

  const document = {
    documentElement,
    querySelectorAll: () => { queries.n++; return { length: mediaElements }; },
  };

  const browser = {
    runtime: {
      onMessage: { addListener: (f) => { onMessage = f; } },
      sendMessage: () => (opts.slowStartup
        ? startup.then(() => ({ value: opts.startupValue === undefined ? 1 : opts.startupValue }))
        : Promise.resolve({ value: opts.startupValue === undefined ? 1 : opts.startupValue })),
    },
  };

  const ctx = {
    browser, chrome: browser, document, console,
    Promise, JSON, Object, Math, Number, String, parseInt, isNaN, RegExp,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  return {
    attrs, queries,
    // Let the startup round trip finish, then drain the microtask queue.
    settled: async () => { releaseStartup(); await startup; await null; await null; },
    state: () => onMessage({ type: "getState" }),
    setVolume: (v) => onMessage({ type: "setVolume", value: v }),
  };
}

(async () => {
  console.log("\n1. A hostile page cannot put its own text in the panel");
  {
    // boostFailKind is read straight off an attribute in the page's DOM, then
    // rendered inside the extension's own popup, styled as the extension's own
    // warning. The popup escapes it, so this is not script injection — but a page
    // could still print a sentence of its choosing in trusted chrome. A
    // DOMException name is always a bare identifier; nothing else is allowed.
    const hostile = [
      ['<img src=x onerror=alert(1)>',                 "markup"],
      ['Gainshift: enter your password to continue',   "a sentence with spaces"],
      ['A'.repeat(2000),                               "an overlong string"],
      ['Invalid State Error',                          "spaces between words"],
      ['InvalidStateError; drop table',                "punctuation"],
      ['',                                             "empty"],
    ];
    for (const [payload, why] of hostile) {
      const t = makeEnv({ "data-gainshift-boostfailkind": payload });
      eq(`rejected — ${why}`, (await t.state()).boostFailKind, "");
    }
  }

  console.log("\n2. A real DOMException name still gets through");
  {
    for (const name of ["InvalidStateError", "SecurityError", "NotSupportedError", "Error"]) {
      const t = makeEnv({ "data-gainshift-boostfailkind": name });
      eq(`accepted — ${name}`, (await t.state()).boostFailKind, name);
    }
  }

  console.log("\n3. The DOM is queried once per state, and only when needed");
  {
    // This used to run querySelectorAll twice per message: once for mediaCount
    // and again for a `domMedia` field that nothing anywhere read.
    const t = makeEnv({}, 4);           // hook not reporting: we must count ourselves
    const s = await t.state();
    eq("counted from the DOM", s.mediaCount, 4);
    eq("one query, not two", t.queries.n, 1);

    const u = makeEnv({ "data-gainshift-media": "9", "data-gainshift-ctx": "2" }, 4);
    const s2 = await u.state();
    eq("the hook's own count wins", s2.mediaCount, 9);
    eq("no DOM query needed at all", u.queries.n, 0);
    eq("the dead domMedia field is gone", "domMedia" in s2, false);
  }

  console.log("\n4. Forged counters are still clamped to numbers");
  {
    const t = makeEnv({
      "data-gainshift-ctx": "not-a-number",
      "data-gainshift-media": "12",
      "data-gainshift-boostfail": "999999999999",
      "data-gainshift-undecorated": "-5",
    }, 0);
    const s = await t.state();
    eq("unparseable context count reads as absent", s.audioContexts, null);
    eq("...so the hook is reported as not running", s.hookAlive, false);
    eq("a forged media count is at least a number", typeof s.mediaCount, "number");
    eq("a forged failure count is a number", typeof s.boostUnavailable, "number");
  }

  console.log("\n5. The level the popup asks for is clamped before use");
  {
    const t = makeEnv({}, 0);
    await t.settled();                  // let startup finish first
    await t.setVolume(99);
    eq("above the range", Number(t.attrs["data-gainshift-gain"]), 6);
    await t.setVolume(-4);
    eq("below the range", Number(t.attrs["data-gainshift-gain"]), 0);
    await t.setVolume("nonsense");
    eq("not a number at all", Number(t.attrs["data-gainshift-gain"]), 0);
    await t.setVolume(0.5);
    eq("a sane value passes through", Number(t.attrs["data-gainshift-gain"]), 0.5);
  }

  console.log("\n6. A level chosen during startup is not undone by it");
  {
    // The startup requestVolume is answered when the background page receives it,
    // so its reply carries the level as of THEN. If the user moves the slider in
    // the meantime, that reply must not put the old level back.
    const t = makeEnv({}, 0, { startupValue: 1, slowStartup: true });
    await t.setVolume(0.35);            // the user chooses, mid-flight
    eq("the user's level is applied", Number(t.attrs["data-gainshift-gain"]), 0.35);
    await t.settled();                  // the stale startup reply now lands
    eq("and the stale reply does not undo it", Number(t.attrs["data-gainshift-gain"]), 0.35);

    // Without a user change, startup still does its job.
    const u = makeEnv({}, 0, { startupValue: 0.6, slowStartup: true });
    await u.settled();
    eq("startup still applies the stored level", Number(u.attrs["data-gainshift-gain"]), 0.6);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
