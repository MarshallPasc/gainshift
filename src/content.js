/*
 * Gainshift - content script (isolated world).
 *
 * Thin relay. All the actual audio work happens in audio-hook.js, which runs in the
 * page's own world where it can patch AudioContext, Audio and HTMLMediaElement.play.
 * This script just carries the volume down to it and reports what it found back up.
 */

(() => {
  "use strict";

  const NS = typeof browser !== "undefined" ? browser : chrome;

  const ATTR_GAIN  = "data-gainshift-gain";
  const ATTR_CTX   = "data-gainshift-ctx";
  const ATTR_MEDIA = "data-gainshift-media";
  const ATTR_BFAIL = "data-gainshift-boostfail";
  const ATTR_BKIND = "data-gainshift-boostfailkind";
  const ATTR_UNDEC = "data-gainshift-undecorated";

  let desired = 1;

  function setPageGain(v) {
    try {
      const r = document.documentElement;
      if (r) r.setAttribute(ATTR_GAIN, String(v));
    } catch (e) { /* ignore */ }
  }

  function readCount(attr) {
    try {
      const r = document.documentElement;
      if (!r) return null;
      const raw = r.getAttribute(attr);
      if (raw === null) return null;      // hook not running here
      const n = parseInt(raw, 10);
      return isNaN(n) ? null : n;
    } catch (e) {
      return null;
    }
  }

  function domMediaCount() {
    try { return document.querySelectorAll("video, audio").length; }
    catch (e) { return 0; }
  }

  function state() {
    const contexts = readCount(ATTR_CTX);
    const tracked  = readCount(ATTR_MEDIA);
    return {
      volume: desired,
      audioContexts: contexts,
      mediaCount: tracked === null ? domMediaCount() : tracked,
      domMedia: domMediaCount(),
      hookAlive: contexts !== null,
      boostUnavailable: readCount(ATTR_BFAIL) || 0,
      boostFailKind: (function () {
        try { return document.documentElement.getAttribute(ATTR_BKIND) || ""; }
        catch (e) { return ""; }
      })(),
      undecorated: readCount(ATTR_UNDEC) || 0,
      boosting: desired > 1
    };
  }

  NS.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === "setVolume") {
      desired = Math.max(0, Math.min(6, Number(msg.value) || 0));
      setPageGain(desired);
      return Promise.resolve(state());
    }

    if (msg.type === "getState") {
      return Promise.resolve(state());
    }
  });

  // Re-apply this tab's volume after a navigation within the frame.
  NS.runtime.sendMessage({ type: "requestVolume" })
    .then((r) => {
      if (r && typeof r.value === "number") {
        desired = r.value;
      }
      // Written even when it's 1, so the page-world hook's level is stated rather
      // than assumed to match its own default.
      setPageGain(desired);
    })
    .catch(() => {});
})();
