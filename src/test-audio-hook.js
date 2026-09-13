/* Test harness for audio-hook.js.
 * Runs the real hook source in a fresh VM context against a mock Web Audio API,
 * so the gain arithmetic can be checked directly rather than reasoned about. */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(process.env.HOOK_SRC || path.join(__dirname, "audio-hook.js"), "utf8");

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = Math.abs(Number(got) - Number(want)) < 1e-9;
  if (ok) { pass++; console.log(`  ok    ${name}  (${got})`); }
  else { fail++; console.log(`  FAIL  ${name}  got ${got}, want ${want}`); }
}
function show(v) {
  if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
  return JSON.stringify(v);
}
function checkEq(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; console.log(`  ok    ${name}  (${show(got)})`); }
  else { fail++; console.log(`  FAIL  ${name}  got ${show(got)}, want ${show(want)}`); }
}

/** Product of every gain between a node and the real destination. */
function effectiveGain(node) {
  let g = 1, cur = node, hops = 0;
  while (cur && hops++ < 20) {
    if (cur.kind === "gain") g *= cur.gain.value;
    if (cur.kind === "destination") break;
    cur = cur.outputs && cur.outputs[0];
  }
  return g;
}

function makeEnv(opts) {
  opts = opts || {};
  const observers = [];
  const created = { contexts: [], sources: [] };
  const routed = new WeakSet();
  const intervals = [];

  class AudioParam { constructor(v) { this.value = v; } }

  class Node {
    constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.outputs = []; }
    connect(dst) { this.outputs.push(dst); return dst; }
    disconnect() { this.outputs.length = 0; }
  }
  class GainNode extends Node {
    constructor(ctx) { super(ctx, "gain"); this.gain = new AudioParam(1); }
  }
  class DestinationNode extends Node {
    constructor(ctx) { super(ctx, "destination"); this.maxChannelCount = 6; }
  }

  class AudioContext {
    constructor() {
      this._dest = new DestinationNode(this);
      this.state = opts.suspended ? "suspended" : "running";
      created.contexts.push(this);
    }
    get destination() { return this._dest; }        // prototype getter, shadowable
    createGain() { return new GainNode(this); }
    createMediaElementSource(el) {
      if (routed.has(el)) {
        const err = new Error("already connected");
        err.name = "InvalidStateError";
        throw err;                       // matches real browser behaviour
      }
      routed.add(el);
      const n = new Node(this, "mediaSource");
      n.el = el;
      created.sources.push(n);
      return n;
    }
    resume() { this.state = "running"; return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
  }

  class MediaElementAudioSourceNode extends Node {
    constructor(ctx, options) {
      super(ctx, "mediaSource");
      this.el = options && options.mediaElement;
      if (routed.has(this.el)) {
        const err = new Error("already connected");
        err.name = "InvalidStateError";
        throw err;
      }
      routed.add(this.el);
      created.sources.push(this);
    }
  }

  class HTMLMediaElement {
    constructor() {
      this._volume = 1; this.paused = true; this.tagName = "AUDIO";
      this._ls = {};
      this.inDocument = false;   // detached by default, like new Audio()
    }
    addEventListener(type, fn) { (this._ls[type] = this._ls[type] || []).push(fn); }
    get volume() { return this._volume; }
    set volume(v) {
      if (this._volume === v) return;
      this._volume = v;
      const ev = { target: this, currentTarget: this };
      // Dispatched on the element. Real elements fire this for our own writes too,
      // so the re-entry guard gets exercised.
      (this._ls["volumechange"] || []).forEach((fn) => fn(ev));
      // volumechange does not bubble; a document listener only sees it via capture,
      // and only if the element is actually IN the document.
      if (this.inDocument) (listeners["volumechange"] || []).forEach((fn) => fn(ev));
    }
    play() { this.paused = false; return Promise.resolve(); }
  }
  class Audio extends HTMLMediaElement {}

  const domMedia = [];
  const attrs = {};

  const documentElement = {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
  };

  const listeners = {};
  const document = {
    documentElement,
    querySelectorAll: () => domMedia.slice(),
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
  };

  class MutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() {}
  }

  const window = {
    AudioContext,
    MediaElementAudioSourceNode,
    webkitAudioContext: undefined,
    HTMLMediaElement,
    Audio,
    MutationObserver,
  };

  if (opts.aliasGetter) {
    // some engines expose the legacy name as a live alias of the modern one
    delete window.webkitAudioContext;
    // getter AND setter, so an assignment to the legacy name really does land on
    // the modern one. A read-only getter would make the hazard impossible and the
    // test meaningless.
    Object.defineProperty(window, "webkitAudioContext", {
      get() { return window.AudioContext; },
      set(v) { window.AudioContext = v; },
      configurable: true
    });
  } else if (opts.aliasCopy) {
    window.webkitAudioContext = AudioContext;   // independent property, same value
  }

  const fakeSetInterval = (fn) => { intervals.push(fn); return intervals.length; };
  const fakeClearInterval = (id) => { if (id) intervals[id - 1] = null; };

  const ctxObj = {
    window, document, MutationObserver, WeakRef,
    setTimeout, clearTimeout,
    setInterval: fakeSetInterval, clearInterval: fakeClearInterval,
    console, Object, Math, parseFloat, isNaN, String, Number, Set, WeakSet, Array,
  };
  ctxObj.globalThis = ctxObj;
  vm.createContext(ctxObj);
  vm.runInContext(SRC, ctxObj);

  return {
    env: ctxObj, window, document, attrs, domMedia, created, observers,
    HTMLMediaElement, Audio,
    // Set the volume the way the content script does, then fire the observer.
    setVolume(v) {
      attrs["data-gainshift-gain"] = String(v);
      observers.forEach((o) => o.cb());
    },
    tick: () => intervals.forEach((f) => f && f()),
    listeners,
    // element the page grabbed before our hook loaded: routed in the browser's
    // eyes, but never seen by our observer, so not in pageRouted
    preRoute: (el) => routed.add(el),
    failKind: () => attrs["data-gainshift-boostfailkind"] || "",
    undecorated: () => Number(attrs["data-gainshift-undecorated"] || 0),
    boostFails: () => Number(attrs["data-gainshift-boostfail"] || 0),
    ctxCount: () => Number(attrs["data-gainshift-ctx"]),
    mediaCount: () => Number(attrs["data-gainshift-media"]),
  };
}

/* ------------------------------------------------------------------ */

console.log("\n1. Web Audio path — master gain inserted before destination");
{
  const t = makeEnv();
  const ctx = new t.window.AudioContext();          // page creates its context
  const master = ctx.destination;                    // should be OUR gain now
  checkEq("destination is a GainNode", master.kind, "gain");
  checkEq("master feeds the real destination", master.outputs[0].kind, "destination");
  checkEq("maxChannelCount mirrored", master.maxChannelCount, 6);
  checkEq("context counted", t.ctxCount(), 1);

  t.setVolume(0.3);
  check("gain follows volume", master.gain.value, 0.3);
}

console.log("\n2. BOOST IS NOT SQUARED  (the bug in 1.6.x)");
{
  const t = makeEnv();
  const el = new t.HTMLMediaElement();
  el.play();                                         // tracked via patched play()
  t.setVolume(2.5);

  const boostSources = t.created.sources.filter((s) => s.el === el);
  checkEq("element routed exactly once", boostSources.length, 1);

  const boostGain = boostSources[0].outputs[0];
  check("boost gain is 2.5, not 6.25", boostGain.gain.value, 2.5);
  check("element volume pinned to 1", el.volume, 1);

  // The boost context must NOT be one of ours, or its own master would
  // multiply the factor a second time.
  checkEq("boost context not double-patched", t.ctxCount(), 0);
  const boostCtxDest = boostGain.outputs[0];
  checkEq("boost gain feeds a real destination", boostCtxDest.kind, "destination");
}

console.log("\n3. Coming back down from boost clears the boost stage");
{
  const t = makeEnv();
  const el = new t.HTMLMediaElement();
  el.play();
  t.setVolume(2.5);
  const boostGain = t.created.sources.filter((s) => s.el === el)[0].outputs[0];
  check("boosted", boostGain.gain.value, 2.5);

  t.setVolume(0.5);
  check("element volume now 0.5", el.volume, 0.5);
  check("boost stage reset to 1", boostGain.gain.value, 1);
}

console.log("\n4. Page-routed media is not scaled twice");
{
  const t = makeEnv();
  const ctx = new t.window.AudioContext();
  const master = ctx.destination;
  const el = new t.HTMLMediaElement();
  ctx.createMediaElementSource(el);                  // the PAGE routes it
  el.play();

  t.setVolume(0.4);
  check("page master gain scales it", master.gain.value, 0.4);
  check("element volume left at 1", el.volume, 1);
}

console.log("\n5. Detached Audio() objects are caught");
{
  const t = makeEnv();
  const a = new t.window.Audio();                    // never added to the DOM
  checkEq("tracked at construction", t.mediaCount(), 1);
  t.setVolume(0.2);
  check("volume applied", a.volume, 0.2);
}

console.log("\n6. play() catches elements never seen before");
{
  const t = makeEnv();
  t.setVolume(0.25);
  const el = new t.HTMLMediaElement();
  checkEq("not yet known", t.mediaCount(), 0);
  el.play();
  checkEq("tracked on play", t.mediaCount(), 1);
  check("current volume applied immediately", el.volume, 0.25);
}

console.log("\n7. Multiple contexts all follow the level");
{
  const t = makeEnv();
  const a = new t.window.AudioContext().destination;
  const b = new t.window.AudioContext().destination;
  checkEq("both counted", t.ctxCount(), 2);
  t.setVolume(0.6);
  check("first", a.gain.value, 0.6);
  check("second", b.gain.value, 0.6);
}

console.log("\n8. Out-of-range values are rejected");
{
  const t = makeEnv();
  const ctx = new t.window.AudioContext();
  t.setVolume(0.5);
  check("valid applied", ctx.destination.gain.value, 0.5);
  t.setVolume(99);                                   // above the 0-6 clamp
  check("absurd value ignored", ctx.destination.gain.value, 0.5);
  t.setVolume(-1);
  check("negative ignored", ctx.destination.gain.value, 0.5);
}

console.log("\n9. Collected elements are pruned from the registry");
{
  const t = makeEnv();
  const keep = new t.HTMLMediaElement();
  keep.play();
  const gone = new t.HTMLMediaElement();
  gone.play();
  checkEq("two tracked", t.mediaCount(), 2);

  // Simulate the GC having collected one: neuter its WeakRef.
  const realDeref = WeakRef.prototype.deref;
  let neutered = false;
  WeakRef.prototype.deref = function () {
    const v = realDeref.call(this);
    if (v === gone && !neutered) { return undefined; }
    return v;
  };
  neutered = false;
  t.setVolume(0.4);
  const after = t.mediaCount();
  WeakRef.prototype.deref = realDeref;

  checkEq("dead entry pruned", after, 1);
  check("survivor still controlled", keep.volume, 0.4);
}

console.log("\n10. Re-entry guard");
{
  const t = makeEnv();
  checkEq("hook marks the window", t.window.__gainshiftHooked, true);
  const before = t.window.AudioContext;
  vm.runInContext(SRC, t.env);                       // inject a second time
  checkEq("second injection is a no-op", t.window.AudioContext, before);
}

console.log("\n11. Constructor form is detected too (bypasses createMediaElementSource)");
{
  const t = makeEnv();
  const ctx = new t.window.AudioContext();
  const master = ctx.destination;
  const el = new t.HTMLMediaElement();
  el.play();
  // modern equivalent of ctx.createMediaElementSource(el)
  new t.window.MediaElementAudioSourceNode(ctx, { mediaElement: el });

  t.setVolume(0.4);
  check("page graph scales it", master.gain.value, 0.4);
  check("element volume left at 1 (not scaled twice)", el.volume, 1);
}

console.log("\n12. A failed routing attempt must not mark the element");
{
  const t = makeEnv();
  const el = new t.HTMLMediaElement();
  el.play();
  t.setVolume(2.5);                       // we route it through our boost graph

  const ctx = new t.window.AudioContext();
  let threw = false;
  try { ctx.createMediaElementSource(el); } catch (e) { threw = true; }
  checkEq("page's attempt throws, as the real API does", threw, true);

  t.setVolume(0.5);
  check("element still controlled after the failed attempt", el.volume, 0.5);
}

console.log("\n13. Ticker re-asserts a level the page overwrote");
{
  const t = makeEnv();
  const el = new t.HTMLMediaElement();
  el.play();
  t.setVolume(0.3);
  check("applied", el.volume, 0.3);

  el.volume = 0.95;                       // the site's own player resets it
  t.tick();
  check("re-asserted by the ticker", el.volume, 0.3);
}

console.log("\n14. While boosting, the element stays pinned at 1");
{
  const t = makeEnv();
  const el = new t.HTMLMediaElement();
  el.play();
  t.setVolume(3);
  check("pinned", el.volume, 1);

  el.volume = 0.4;                        // engine lowers it mid-playback
  t.tick();
  check("re-pinned so boost isn't multiplied down", el.volume, 1);
}

console.log("\n15. Ticker stops when back at 100%");
{
  const t = makeEnv();
  const el = new t.HTMLMediaElement();
  el.play();
  t.setVolume(0.5);
  t.setVolume(1);
  el.volume = 0.77;                       // page sets its own volume, legitimately
  t.tick();
  check("we no longer interfere at 100%", el.volume, 0.77);
}

console.log("\n16. Cycling boost 50 times creates ONE route and ONE context");
{
  const t = makeEnv();
  const el = new t.HTMLMediaElement();
  el.play();
  for (let i = 0; i < 50; i++) { t.setVolume(6); t.setVolume(1); }
  t.setVolume(6);

  checkEq("element routed exactly once", t.created.sources.filter(s => s.el === el).length, 1);
  checkEq("one boost context, not fifty", t.created.contexts.length, 1);
  const g = t.created.sources.filter(s => s.el === el)[0].outputs[0];
  check("gain is 6, not compounded", g.gain.value, 6);
  check("element still pinned at 1", el.volume, 1);
}

console.log("\n17. A route that throws is recorded as FAILED, not as boosted");
{
  const t = makeEnv();
  const el = new t.HTMLMediaElement();
  t.preRoute(el);                    // grabbed before our hook existed
  el.play();

  t.setVolume(4);                    // our routing attempt must throw
  checkEq("failure counted", t.boostFails(), 1);
  checkEq("no source node created for it", t.created.sources.filter(s => s.el === el).length, 0);
  check("element left at 1 - can't boost, but not broken", el.volume, 1);

  t.setVolume(0.5);
  check("still controlled below 100%", el.volume, 0.5);

  // a rebuilt graph clears the failure and gives it one more chance
  t.setVolume(4);
  t.created.contexts[0].close();
  const fresh = new t.HTMLMediaElement();
  fresh.play();
  t.setVolume(4.5);
  checkEq("count reset with the rebuilt graph", t.boostFails() <= 1, true);
}

console.log("\n18. A closed boost context is rebuilt, not failed against forever");
{
  const t = makeEnv();
  const a = new t.HTMLMediaElement();
  a.play();
  t.setVolume(3);
  checkEq("boost context created", t.created.contexts.length, 1);

  t.created.contexts[0].close();            // browser reclaims it
  const b = new t.HTMLMediaElement();
  b.play();
  t.setVolume(3.5);

  checkEq("a new context was built", t.created.contexts.length, 2);
  const g = t.created.sources.filter(s => s.el === b)[0].outputs[0];
  check("new element boosted through the new graph", g.gain.value, 3.5);
}

console.log("\n19. volumechange corrects instantly - attached AND detached");
{
  const t = makeEnv();

  const inDoc = new t.HTMLMediaElement();
  inDoc.inDocument = true;
  inDoc.play();

  const detached = new t.window.Audio();     // never added to the page
  detached.play();

  t.setVolume(0.3);
  check("attached applied", inDoc.volume, 0.3);
  check("detached applied", detached.volume, 0.3);

  inDoc.volume = 0.9;                        // the site's player resets it
  check("attached corrected on the event", inDoc.volume, 0.3);

  detached.volume = 0.9;                     // a pooled Howler object resets itself
  check("detached corrected too (no document listener would see this)", detached.volume, 0.3);
}

console.log("\n20. At 100% we never fight the page for control");
{
  const t = makeEnv();
  const el = new t.HTMLMediaElement();
  el.play();
  t.setVolume(0.5);
  t.setVolume(1);
  el.volume = 0.77;                         // legitimate page-side change
  check("left alone", el.volume, 0.77);
  t.tick();
  check("still left alone after a tick", el.volume, 0.77);
}

console.log("\n21. Several boosted elements share ONE graph and all follow the level");
{
  const t = makeEnv();
  const a = new t.HTMLMediaElement();
  const b = new t.HTMLMediaElement();
  a.play(); b.play();

  t.setVolume(3);
  checkEq("one boost context for both", t.created.contexts.length, 1);

  const ga = t.created.sources.filter(s => s.el === a)[0].outputs[0];
  const gb = t.created.sources.filter(s => s.el === b)[0].outputs[0];
  checkEq("both routed into the same gain node", ga === gb, true);
  check("gain applied", ga.gain.value, 3);

  t.setVolume(5);
  check("first element's gain followed the change", ga.gain.value, 5);
  check("second element's gain followed the change", gb.gain.value, 5);
  check("both pinned at 1", a.volume + b.volume, 2);

  // and a third joining later must land in the same graph, not a new one
  const c = new t.HTMLMediaElement();
  c.play();
  checkEq("late joiner reuses the graph", t.created.contexts.length, 1);
  const gc = t.created.sources.filter(s => s.el === c)[0].outputs[0];
  checkEq("same gain node", gc === ga, true);
  check("late joiner at the current level", gc.gain.value, 5);
}

console.log("\n22. A suspended boost context is resumed, not left silent");
{
  const t = makeEnv({ suspended: true });     // autoplay policy
  const el = new t.HTMLMediaElement();
  el.play();
  t.setVolume(3);

  const boostCtx = t.created.contexts[0];
  checkEq("a boost context was built", !!boostCtx, true);
  checkEq("resumed rather than left suspended", boostCtx.state, "running");
  check("and the element is actually routed", t.created.sources.filter(s => s.el === el).length, 1);
}

console.log("\n23. Boost failures are classified, not all blamed on CORS");
{
  const t = makeEnv();
  const el = new t.HTMLMediaElement();
  t.preRoute(el);                  // page grabbed it first -> InvalidStateError
  el.play();
  t.setVolume(4);
  checkEq("failure counted", t.boostFails(), 1);
  checkEq("error name recorded", t.failKind(), "InvalidStateError");

  // On rebuild the set and counter clear, the element is retried, and it fails
  // again - so the count reflects what is true NOW rather than accumulating.
  t.created.contexts[0].close();
  const fresh = new t.HTMLMediaElement();
  fresh.play();
  t.setVolume(4.5);
  checkEq("count reflects current state, not history", t.boostFails(), 1);
  check("the healthy element still boosts", 
        t.created.sources.filter(s => s.el === fresh)[0].outputs[0].gain.value, 4.5);
}

console.log("\n24. A context we could not decorate is counted, not hidden");
{
  const t = makeEnv();
  checkEq("none yet", t.undecorated(), 0);
  // make decoration throw for the next context
  const realCreateGain = t.env.window.AudioContext.prototype.createGain;
  t.env.window.AudioContext.prototype.createGain = function () { throw new Error("nope"); };
  new t.window.AudioContext();
  t.env.window.AudioContext.prototype.createGain = realCreateGain;

  checkEq("undecorated context counted", t.undecorated(), 1);
  checkEq("and not claimed as intercepted", t.ctxCount(), 0);
}

console.log("\n25. Aliased constructor names are not wrapped twice");
{
  // webkitAudioContext === AudioContext. Without a guard the second patch wraps
  // the first, every context is decorated twice, and the gain is squared.
  const t = makeEnv({ aliasGetter: true });

  const ctx = new t.window.webkitAudioContext();
  const master = ctx.destination;
  checkEq("one gain, feeding the real destination directly",
          master.outputs[0].kind, "destination");
  checkEq("only one context intercepted", t.ctxCount(), 1);

  t.setVolume(0.5);
  // What matters is the product along the chain to the destination, not the value
  // on any single node. Two chained gains of 0.5 each read as 0.5 individually
  // while actually delivering 0.25.
  check("effective gain to the speakers is 0.5, not 0.25", effectiveGain(master), 0.5);
}

console.log("\n26. Two independent names both still get covered");
{
  // webkitAudioContext is a separate property holding the real constructor.
  // Each name must get its own wrapper - refusing the second would leave pages
  // that use the legacy name with no coverage at all.
  const t = makeEnv({ aliasCopy: true });

  const viaLegacy = new t.window.webkitAudioContext();
  checkEq("legacy name still intercepted", viaLegacy.destination.kind, "gain");

  const viaModern = new t.window.AudioContext();
  checkEq("modern name intercepted", viaModern.destination.kind, "gain");

  t.setVolume(0.4);
  check("legacy-created context follows", viaLegacy.destination.gain.value, 0.4);
  check("modern-created context follows", viaModern.destination.gain.value, 0.4);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
