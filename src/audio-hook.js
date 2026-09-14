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

  // Element volume ownership. We have to be able to tell OUR value from the
  // page's. Writing a flat 1 over a level the page chose is audible, and it used
  // to happen even at 100%, where this extension is supposed to be inert.
  const originalVolume = new WeakMap(); // el -> volume before we first wrote it
  const ourWrite = new WeakMap();       // el -> the last value WE wrote

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

  // Every setAttribute on <html> is a DOM mutation, and it wakes any
  // MutationObserver the page keeps on documentElement - frameworks commonly have
  // one. Four of these five attributes rarely change, so remembering what was
  // last written and skipping the no-ops removes most of that traffic: a game
  // preloading 300 pooled sounds went from 1500 attribute writes to about 300.
  const written = Object.create(null);

  function put(r, attr, value) {
    if (written[attr] === value) return;
    written[attr] = value;
    r.setAttribute(attr, value);
  }

  /** `counts` lets applyAll hand over registry lengths it has just computed,
      instead of making us walk both registries a second time. */
  function announce(counts) {
    const r = root();
    if (!r) return;
    try {
      put(r, ATTR_CTX, String(counts ? counts.ctx : live(gainRefs).length));
      put(r, ATTR_MEDIA, String(counts ? counts.media : live(mediaRefs).length));
      put(r, ATTR_BFAIL, String(boostFailures));
      put(r, ATTR_BKIND, boostFailKind);
      put(r, ATTR_UNDEC, String(undecorated));
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
      // Reflect.construct rather than `new Real(...)`, so new.target survives:
      // otherwise `class X extends AudioContext {}` yields an instance carrying
      // AudioContext.prototype instead of X.prototype.
      if (!new.target) {
        throw new TypeError("Failed to construct '" + name + "': Please use the 'new' operator.");
      }
      const ctx = Reflect.construct(Real, args, new.target);
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
    try {
      if (!el) return;
      pageRouted.add(el);
      releaseToPage(el);
    } catch (e) { /* ignore */ }
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
        if (!new.target) {
          throw new TypeError("Failed to construct 'MediaElementAudioSourceNode': Please use the 'new' operator.");
        }
        const node = Reflect.construct(RealSourceNode, [ctx, options], new.target);
        if (options) markPageRouted(options.mediaElement);
        return node;
      }
      PatchedSourceNode.prototype = RealSourceNode.prototype;
      try { Object.setPrototypeOf(PatchedSourceNode, RealSourceNode); } catch (e) { /* ignore */ }
      try {
        Object.defineProperty(PatchedSourceNode, "name",
          { value: "MediaElementAudioSourceNode", configurable: true });
      } catch (e) { /* ignore */ }
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

  /** Every write to an element's volume goes through here, so we always know
      which value is ours and what the page had before we touched it.

      The original is re-read each time we TAKE OVER, not just the first time the
      element was ever seen. Between spells at 100% the element belongs to the
      page again, and a player may well have moved its own level while we were
      not holding it; handing back a value from two takeovers ago would be its
      own small bug. While we are holding it, ourWrite is set and the recorded
      original survives our own re-writes. */
  /** The page's own level for this element - the number our factor multiplies.
      1 until we have seen the element. */
  function pageBase(el) {
    return originalVolume.has(el) ? originalVolume.get(el) : 1;
  }

  function setElementVolume(el, factor) {
    if (!ourWrite.has(el)) originalVolume.set(el, el.volume);

    // Gainshift is a MULTIPLIER, not a replacement. The Web Audio path has
    // always been one - our master gain scales whatever the page's own graph
    // produced - and the media-element path was the odd one out, writing the
    // factor straight into el.volume. So a video the user had already turned
    // down to 20% in the site's own player jumped to 50% when they set
    // Gainshift to 50%: LOUDER than before they touched the extension, and the
    // site's own control silently discarded. 50% now means half of whatever the
    // page was doing, which is what "50%" has always claimed to mean.
    const target = Math.max(0, Math.min(1, pageBase(el) * factor));

    // Claim it BEFORE the write. Assigning el.volume fires volumechange
    // synchronously, which comes straight back through here - and with the claim
    // recorded afterwards that re-entrant call looked like a fresh takeover and
    // filed our own new value as "what the page had". The element then never got
    // its real level back. Recorded twice because the browser may clamp what we
    // asked for; the second is what actually landed.
    ourWrite.set(el, target);
    if (Math.abs(el.volume - target) > 0.01) el.volume = target;
    ourWrite.set(el, el.volume);
  }

  /** Hand the element back to the page: either because the page has taken it
      into its own graph, or because we are at 100% and have nothing to say.
      Give back what it had before we interfered - but only if our value is still
      the one standing. If the page has set its own level since, that is the one
      that should win. */
  function releaseToPage(el) {
    if (!ourWrite.has(el)) return;
    const mine = ourWrite.get(el);
    ourWrite.delete(el);
    try {
      if (Math.abs(el.volume - mine) > 0.01) return;   // the page moved it; leave it
      const base = pageBase(el);
      if (Math.abs(el.volume - base) > 0.01) el.volume = base;
    } catch (e) { /* ignore */ }
  }

  function applyToElement(el) {
    try {
      if (pageRouted.has(el)) {
        // The page routed this into its own graph, where our master gain already
        // scales the result. Its element.volume belongs to the page: writing 1
        // here overrode a level the page had chosen for its own mix, making such
        // sites up to twice as loud as intended - and it did so even at 100%.
        return;
      }

      if (current === 1) {
        // 100% means "as though the extension were not installed" - which is
        // what onVolumeChange has always said (`if (current === 1) return`),
        // while this function disagreed and wrote 1 anyway. A player that
        // restores its own saved level - a video site you keep at 30% - was
        // pushed to full volume by an extension the user had never touched.
        //
        // An element we have never written to is left exactly as it is;
        // releaseToPage returns immediately for those. One we did write to gets
        // ITS OWN level back, not 1, so dragging the slider to 100% undoes us
        // rather than overriding the page. Either way, if the page has moved the
        // value since we wrote it, releaseToPage leaves the page's value alone.
        releaseToPage(el);
        return;
      }

      if (current < 1) {
        setElementVolume(el, current);
        return;
      }

      // Boost: hold the element at the PAGE's own level (factor 1) and put the
      // amplification in our gain node, so the result is still the page's level
      // times our factor rather than full volume times our factor.
      setElementVolume(el, 1);
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
        if (!new.target) {
          throw new TypeError("Failed to construct 'Audio': Please use the 'new' operator.");
        }
        // new.target is forwarded so `class Sound extends Audio {}` still produces
        // an instance carrying Sound.prototype. `new RealAudio(...)` discarded it.
        const el = Reflect.construct(RealAudio, args, new.target);
        try { track(el); } catch (e) { /* ignore */ }
        return el;
      }
      PatchedAudio.prototype = RealAudio.prototype;
      try { Object.setPrototypeOf(PatchedAudio, RealAudio); } catch (e) { /* ignore */ }
      // The AudioContext wrapper already preserved its .name; this one did not,
      // so feature detection saw "PatchedAudio".
      try {
        Object.defineProperty(PatchedAudio, "name", { value: "Audio", configurable: true });
      } catch (e) { /* ignore */ }
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
    if (!ourWrite.has(el)) return;                // not ours to hold

    // Whose change was this? If the value is not the one we last wrote, the
    // PAGE moved it - the viewer using the site's own volume control while
    // Gainshift is engaged. Stamping our number back on top is what made the
    // site's slider feel broken; instead, take the new value as the page's
    // level and re-apply our factor over it. The site's control keeps working,
    // and our factor keeps meaning what it says.
    if (Math.abs(el.volume - ourWrite.get(el)) > 0.01) originalVolume.set(el, el.volume);

    // Our own write re-fires this handler; the second pass matches and stops.
    try { setElementVolume(el, current <= 1 ? current : 1); } catch (err) { /* ignore */ }
  }

  function scanDom() {
    try {
      for (const el of document.querySelectorAll("video, audio")) track(el);
    } catch (e) { /* ignore */ }
  }

  /* ---------- applying ---------- */

  function applyAll(v) {
    current = v;

    const gains = live(gainRefs);
    for (const g of gains) {
      try { g.gain.value = v; } catch (e) { /* node's context is gone */ }
    }

    // Reset our own boost stage whenever we're at or below 100%, otherwise a
    // previous boost stays multiplied in after coming back down.
    if (boostGain) {
      try { boostGain.gain.value = v > 1 ? v : 1; } catch (e) { /* ignore */ }
    }

    const medias = live(mediaRefs);
    for (const el of medias) applyToElement(el);

    // Autoplay policy can suspend it again later, not only at creation.
    if (v > 1 && boostCtx && boostCtx.state === "suspended") {
      try { boostCtx.resume(); } catch (e) { /* ignore */ }
    }

    // Both registries were just pruned; reuse those counts rather than walking
    // them a second and third time inside announce().
    announce({ ctx: gains.length, media: medias.length });
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
              setElementVolume(el, current);
            } else if (boosted.has(el)) {
              // Boost comes from the gain node; the element itself must stay at 1
              // or the engine's own changes multiply into it.
              setElementVolume(el, 1);
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

  let applied = false;

  function readAttr() {
    const r = root();
    if (!r) return;
    const raw = r.getAttribute(ATTR_GAIN);
    if (raw === null) return;
    const v = parseFloat(raw);
    if (isNaN(v) || v < 0 || v > 6) return;
    // The content script rewrites this attribute on every message, including ones
    // carrying the level we already hold. Re-running the whole pass for those
    // costs a walk of both registries and five attribute writes, for nothing.
    if (applied && v === current) return;
    applied = true;
    applyAll(v);
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
