/*
 * Gainshift - page-world hook.
 *
 * Runs in the PAGE's own JS world at document_start, before the page's scripts.
 * It owns all three ways a page can make noise:
 *
 *   1. Web Audio        - patch AudioContext so ctx.destination returns our master gain.
 *   2. DOM media        - <audio>/<video> found in the document.
 *   3. Detached media   - new Audio(...) objects never inserted into the DOM. Howler.js
 *                         and most game engines pool these; querySelectorAll can't see
 *                         them, which is why DOM-scanning extensions find "no audio"
 *                         on pages that are plainly making sound.
 *
 * Elements are captured at construction (patched Audio) and at playback (patched
 * HTMLMediaElement.prototype.play). That covers the paths a page normally uses,
 * but it is interception, not a guarantee: code that reaches audio some other way
 * is not covered.
 *
 * Talks to the content script through data attributes on <html>, visible to both
 * worlds, so no cloneInto/exportFunction and no CSP interaction.
 */

(() => {
  "use strict";

  if (window.__gainshiftHooked) return;
  window.__gainshiftHooked = true;

  const ATTR_GAIN  = "data-gainshift-gain";   // content script writes, we read
  const ATTR_CTX   = "data-gainshift-ctx";    // we write
  const ATTR_MEDIA = "data-gainshift-media";  // we write
  const ATTR_BFAIL = "data-gainshift-boostfail"; // we write
  const ATTR_BKIND = "data-gainshift-boostfailkind"; // we write
  const ATTR_UNDEC = "data-gainshift-undecorated";   // we write

  // Captured BEFORE anything is patched. Everything we build for ourselves uses
  // these, so our own graph is never routed through our own patches.
  const RealAudioContext =
    window.AudioContext || window.webkitAudioContext || null;
  const realCreateMediaElementSource =
    RealAudioContext && RealAudioContext.prototype
      ? RealAudioContext.prototype.createMediaElementSource
      : null;

  // WeakRef registries: we need to iterate these, but must never be the reason a
  // page object stays alive. Dead entries are pruned on every pass.
  const gainRefs = [];   // WeakRef<GainNode>   - one master per page AudioContext
  const mediaRefs = [];  // WeakRef<HTMLMediaElement>

  const seenMedia  = new WeakSet();  // already registered, don't double-add
  const boosted    = new WeakSet();  // successfully routed through OUR boost graph
  const pageRouted = new WeakSet();  // the PAGE routed this into its own graph
  let   boostFailed = new WeakSet(); // routing was attempted and threw - NOT the same
                                     // as boosted. Replaced wholesale when the boost
                                     // graph is rebuilt, so a fresh graph gets a retry.
  let   boostFailures = 0;           // count, for the popup
  let   boostFailKind = "";          // DOMException name of the last failure
  let   undecorated = 0;             // contexts we could not intercept at all

  let current = 1;
  let boostCtx = null;
  let boostGain = null;
  let ticker = null;

  const root = () => document.documentElement;

  /** Live entries, pruning collected ones as we go. */
  function live(refs) {
    const out = [];
    for (let i = refs.length - 1; i >= 0; i--) {
      const v = refs[i].deref();
      if (v === undefined) refs.splice(i, 1);
      else out.push(v);
    }
    return out;
  }

  function announce() {
    const r = root();
    if (!r) return;
    try {
      r.setAttribute(ATTR_CTX, String(live(gainRefs).length));
      r.setAttribute(ATTR_MEDIA, String(live(mediaRefs).length));
      r.setAttribute(ATTR_BFAIL, String(boostFailures));
      r.setAttribute(ATTR_BKIND, boostFailKind);
      r.setAttribute(ATTR_UNDEC, String(undecorated));
    } catch (e) { /* ignore */ }
  }

  /* ---------- 1. Web Audio ---------- */

  function decorate(ctx) {
    const realDestination = ctx.destination;
    const master = ctx.createGain();
    master.gain.value = current;
    master.connect(realDestination);

    // A GainNode is not an AudioDestinationNode. Libraries that read
    // maxChannelCount off ctx.destination would otherwise get undefined and
    // mis-configure their channel layout, so mirror it through.
    try {
      Object.defineProperty(master, "maxChannelCount", {
        get() { return realDestination.maxChannelCount; },
        configurable: true
      });
    } catch (e) { /* ignore */ }

    Object.defineProperty(ctx, "destination", {
      get() { return master; },
      configurable: true
    });

    gainRefs.push(new WeakRef(master));
    announce();
  }

  const ourWrappers = new Set();

  function patchContext(name) {
    const Real = window[name];
    if (typeof Real !== "function") return;
    // Only refuse when the name already resolves to one of OUR wrappers - which
    // happens if the second name is a getter aliasing the first. Wrapping that
    // would decorate every context twice and square the gain. Two names that
    // independently point at the real constructor each get their own wrapper,
    // which is correct: a context is built by exactly one of them.
    if (ourWrappers.has(Real)) return;

    function Patched(...args) {
      const ctx = new Real(...args);
      try {
        decorate(ctx);
      } catch (e) {
        // Hand back an untouched context rather than breaking the page's audio.
        // Counted, so status doesn't claim coverage we don't have.
        undecorated++;
        announce();
      }
      return ctx;
    }

    Patched.prototype = Real.prototype;
    try { Object.setPrototypeOf(Patched, Real); } catch (e) { /* ignore */ }
    try {
      Object.defineProperty(Patched, "name", { value: name, configurable: true });
    } catch (e) { /* ignore */ }
    ourWrappers.add(Patched);
    try { window[name] = Patched; } catch (e) { /* ignore */ }
  }

  patchContext("AudioContext");
  patchContext("webkitAudioContext");

  // Learn which elements the PAGE routes into its own graph. Those are already
  // scaled by the master gain above, so we must not also scale el.volume - that
  // would apply our factor twice.
  function markPageRouted(el) {
    try { if (el) pageRouted.add(el); } catch (e) { /* ignore */ }
  }

  if (RealAudioContext && realCreateMediaElementSource) {
    try {
      RealAudioContext.prototype.createMediaElementSource = function (el) {
        // Mark only once the call SUCCEEDS. It throws when the element is already
        // routed, and marking a failed attempt would leave that element believing
        // a page graph controls it when nothing does.
        const node = realCreateMediaElementSource.call(this, el);
        markPageRouted(el);
        return node;
      };
    } catch (e) { /* ignore */ }
  }

  // The constructor form does the same job and never goes through the method above.
  try {
    const RealSourceNode = window.MediaElementAudioSourceNode;
    if (typeof RealSourceNode === "function") {
      function PatchedSourceNode(ctx, options) {
        const node = new RealSourceNode(ctx, options);
        if (options) markPageRouted(options.mediaElement);
        return node;
      }
      PatchedSourceNode.prototype = RealSourceNode.prototype;
      try { Object.setPrototypeOf(PatchedSourceNode, RealSourceNode); } catch (e) { /* ignore */ }
      window.MediaElementAudioSourceNode = PatchedSourceNode;
    }
  } catch (e) { /* ignore */ }

  /* ---------- 2 + 3. media elements, attached or not ---------- */

  function track(el) {
    if (!el || seenMedia.has(el)) return;
    seenMedia.add(el);
    mediaRefs.push(new WeakRef(el));
    try { el.addEventListener("volumechange", onVolumeChange); } catch (e) { /* ignore */ }
    announce();
    applyToElement(el);
  }

  function ensureBoostGraph() {
    // A context can be closed out from under us - by the page, or by the browser
    // reclaiming resources. Treat that as "no graph" and build a new one, rather
    // than failing every route forever against a dead context.
    if (boostCtx && boostCtx.state !== "closed") return true;
    if (!RealAudioContext) return false;
    try {
      // Built from the real constructor, so this context's destination is the
      // genuine one and our gain is applied exactly once.
      boostCtx = new RealAudioContext();
      boostGain = boostCtx.createGain();
      boostGain.gain.value = current > 1 ? current : 1;
      boostGain.connect(boostCtx.destination);
      // A context created outside a user gesture can start suspended. An element
      // routed into a suspended context is silent - worse than not boosting at all.
      if (boostCtx.state === "suspended") {
        try { boostCtx.resume(); } catch (e) { /* ignore */ }
      }
      boostFailed = new WeakSet();   // new graph, everything deserves one more try
      boostFailures = 0;             // ...so the count it describes resets with it
      boostFailKind = "";
      return true;
    } catch (e) {
      boostCtx = null;
      boostGain = null;
      return false;
    }
  }

  function applyToElement(el) {
    try {
      if (pageRouted.has(el)) {
        // Scaled by the page's own graph, which our master gain sits in.
        el.volume = 1;
        return;
      }

      if (current <= 1) {
        el.volume = current;
        return;
      }

      // Boost: pin the element and amplify through our gain node.
      el.volume = 1;
      if (!boosted.has(el) && !boostFailed.has(el) && ensureBoostGraph()) {
        try {
          // Call the real method, so our own routing isn't recorded as the
          // page's in pageRouted.
          realCreateMediaElementSource.call(boostCtx, el).connect(boostGain);
          boosted.add(el);
        } catch (e) {
          // Recorded as a FAILURE, not as boosted. InvalidStateError means the
          // element is already associated with another source node, which is
          // permanent for that element. Other names (SecurityError, and whatever
          // a given browser chooses) are recorded too rather than assumed to mean
          // the same thing. Either way we don't retry against THIS graph; a
          // rebuilt graph clears the set and gives it one more chance.
          boostFailed.add(el);
          boostFailures++;
          boostFailKind = (e && e.name) ? String(e.name) : "Error";
          announce();
        }
      }
    } catch (e) { /* ignore */ }
  }

  // Catch anything that plays, whether it's in the DOM or not.
  try {
    const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (proto && typeof proto.play === "function") {
      const realPlay = proto.play;
      proto.play = function (...args) {
        try { track(this); } catch (e) { /* ignore */ }
        return realPlay.apply(this, args);
      };
    }
  } catch (e) { /* ignore */ }

  // Catch pooled elements at construction - Howler's HTML5 mode does this.
  try {
    const RealAudio = window.Audio;
    if (typeof RealAudio === "function") {
      function PatchedAudio(...args) {
        const el = new RealAudio(...args);
        try { track(el); } catch (e) { /* ignore */ }
        return el;
      }
      PatchedAudio.prototype = RealAudio.prototype;
      try { Object.setPrototypeOf(PatchedAudio, RealAudio); } catch (e) { /* ignore */ }
      window.Audio = PatchedAudio;
    }
  } catch (e) { /* ignore */ }

  // A page resetting element.volume fires volumechange. Reacting to it is instant
  // where polling is not. Bound per element rather than on document: volumechange
  // does not bubble, and a detached Audio() is not in the document tree at all, so
  // a document-level listener would never see the pooled objects that matter most.
  function onVolumeChange(e) {
    const el = (e && (e.target || e.currentTarget));
    if (!el || current === 1) return;             // at 100% we never interfere
    if (pageRouted.has(el)) return;               // the page's graph owns it
    const want = current <= 1 ? current : 1;
    // Our own write re-fires this handler; the second pass matches and stops.
    if (Math.abs(el.volume - want) > 0.01) {
      try { el.volume = want; } catch (err) { /* ignore */ }
    }
  }

  function scanDom() {
    try {
      for (const el of document.querySelectorAll("video, audio")) track(el);
    } catch (e) { /* ignore */ }
  }

  /* ---------- applying ---------- */

  function applyAll(v) {
    current = v;

    for (const g of live(gainRefs)) {
      try { g.gain.value = v; } catch (e) { /* node's context is gone */ }
    }

    // Reset our own boost stage whenever we're at or below 100%, otherwise a
    // previous boost stays multiplied in after coming back down.
    if (boostGain) {
      try { boostGain.gain.value = v > 1 ? v : 1; } catch (e) { /* ignore */ }
    }

    for (const el of live(mediaRefs)) applyToElement(el);

    // Autoplay policy can suspend it again later, not only at creation.
    if (v > 1 && boostCtx && boostCtx.state === "suspended") {
      try { boostCtx.resume(); } catch (e) { /* ignore */ }
    }

    announce();      // registries were just pruned; republish the real counts
    manageTicker();
  }

  // Safety net only - volumechange above does the real work. This rescans the DOM,
  // so it finds <audio>/<video> that appeared without firing play/loadedmetadata.
  // It does NOT discover detached Audio() objects - those arrive only through the
  // patched constructor and play(). Every 5s, and only while we're off 100%.
  function manageTicker() {
    const needed = current !== 1;
    if (needed && !ticker) {
      ticker = setInterval(() => {
        scanDom();
        for (const el of live(mediaRefs)) {
          try {
            if (pageRouted.has(el)) continue;
            if (current <= 1) {
              if (Math.abs(el.volume - current) > 0.01) el.volume = current;
            } else if (boosted.has(el)) {
              // Boost comes from the gain node; the element itself must stay at 1
              // or the engine's own changes multiply into it.
              if (Math.abs(el.volume - 1) > 0.01) el.volume = 1;
            }
          } catch (e) { /* ignore */ }
        }
      }, 5000);
    } else if (!needed && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  /* ---------- listen for changes from the content script ---------- */

  function readAttr() {
    const r = root();
    if (!r) return;
    const raw = r.getAttribute(ATTR_GAIN);
    if (raw === null) return;
    const v = parseFloat(raw);
    if (!isNaN(v) && v >= 0 && v <= 6) applyAll(v);
  }

  function start() {
    const r = root();
    if (!r) { setTimeout(start, 0); return; }

    readAttr();
    scanDom();
    announce();

    try {
      new MutationObserver(readAttr)
        .observe(r, { attributes: true, attributeFilter: [ATTR_GAIN] });
    } catch (e) { /* ignore */ }

    document.addEventListener("DOMContentLoaded", scanDom, { once: true });
  }

  start();
})();
