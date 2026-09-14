/* Test harness for background.js — per-site memory, tab overrides, persistence. */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok    ${name}  (${JSON.stringify(got)})`); }
  else { fail++; console.log(`  FAIL  ${name}  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

function makeEnv(initialSites = {}, opts = {}) {
  const stored = { siteVolumes: { ...initialSites } };
  const writes = [];
  const tabs = new Map();          // tabId -> url
  const badges = [];
  const colors = [];
  const icons  = [];
  const titles = [];
  const sent = [];
  let onMessage = null, onUpdated = null, onRemoved = null, onCommand = null;
  let activeTab = null;

  const browser = {
    storage: {
      local: {
        get: async () => JSON.parse(JSON.stringify(stored)),
        set: (o) => { writes.push(JSON.parse(JSON.stringify(o))); Object.assign(stored, o); },
      },
    },
    tabs: {
      // The keyboard handler asks which tab is in front.
      query: async () => (activeTab !== null && tabs.has(activeTab)
        ? [{ id: activeTab, url: tabs.get(activeTab) }]
        : []),
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("no tab");
        return { id, url: tabs.get(id) };
      },
      sendMessage: async (tabId, payload, opts) => {
        sent.push({ tabId, payload, frameId: opts && opts.frameId });
        return { ok: true };
      },
      onRemoved: { addListener: (f) => { onRemoved = f; } },
      onUpdated: { addListener: (f) => { onUpdated = f; } },
    },
    runtime: { onMessage: { addListener: (f) => { onMessage = f; } } },
    commands: { onCommand: { addListener: (f) => { onCommand = f; } } },
    webNavigation: {
      getAllFrames: async ({ tabId }) => [
        { frameId: 0, url: tabs.get(tabId) || "about:blank" },
        { frameId: 1, url: "https://cdn.example.com/player" },
      ],
    },
    browserAction: (() => {
      // Firefox's browserAction.* return promises. When the tab has gone, they
      // REJECT — which a plain try/catch around the call cannot see.
      const reply = () => opts.toolbarFails
        ? Promise.reject(new Error("Invalid tab ID"))
        : Promise.resolve();
      return {
        setBadgeText: (o) => { badges.push(o); return reply(); },
        setBadgeBackgroundColor: (o) => { colors.push(o); return reply(); },
        setIcon: (o) => { icons.push(o); return reply(); },
        setTitle: (o) => { titles.push(o); return reply(); },
      };
    })(),
  };

  const ctx = {
    browser, chrome: browser, console, URL,
    setTimeout, clearTimeout, Promise, JSON, Object, Math, Array, Map, Number, String,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  return {
    stored, writes, tabs, badges, colors, icons, titles, sent,
    // Last value each toolbar API was called with, which is what the user
    // actually ends up looking at.
    lastIcon:  () => (icons[icons.length - 1]   || {}).path,
    lastBadge: () => (badges[badges.length - 1] || {}).text,
    lastColor: () => (colors[colors.length - 1] || {}).color,
    lastTitle: () => (titles[titles.length - 1] || {}).title,
    // The level the frames were last actually told to use. lookupVolume answers
    // the popup from the maps; this is what reaches the audio, and the two can
    // disagree if a code path computes the level twice.
    lastPushed: () => {
      const m = [...sent].reverse().find((s) => s.payload && s.payload.type === "setVolume");
      return m ? m.payload.value : null;
    },
    msg: (m, sender) => onMessage(m, sender || {}),
    // A keystroke, as browser.commands would deliver it. The listener is
    // fire-and-forget, so give its async body a turn to finish.
    key: async (name) => { onCommand(name); await wait(5); },
    activate: (id) => { activeTab = id; },
    // Everything the popup would be told when it opens.
    look: (id) => onMessage({ type: "lookupVolume", tabId: id }, {}),
    set: (id, value, scope) =>
      onMessage({ type: "storeVolume", tabId: id, value, scope }, {}),
    update: (tabId, changeInfo, tab) => onUpdated(tabId, changeInfo, tab),
    remove: (tabId) => onRemoved(tabId),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* background.js must not leave a rejected promise lying around when a toolbar
   call fails. Node reports those here, once the microtask queue has drained. */
const unhandled = [];
process.on("unhandledRejection", (r) => unhandled.push(String((r && r.message) || r)));

(async () => {
  console.log("\n1. Hostname keying — www stripped, path ignored");
  {
    const t = makeEnv();
    t.tabs.set(1, "https://www.youtube.com/watch?v=abc123");
    await t.msg({ type: "storeVolume", tabId: 1, value: 0.3 });
    await wait(320);
    eq("stored under bare hostname", Object.keys(t.stored.siteVolumes), ["youtube.com"]);
    eq("value stored", t.stored.siteVolumes["youtube.com"], 0.3);

    t.tabs.set(2, "https://youtube.com/feed/subscriptions");
    const r = await t.msg({ type: "lookupVolume", tabId: 2 });
    eq("different page, same site, same level", r.value, 0.3);
    eq("reported as remembered", r.remembered, true);
  }

  console.log("\n2. Setting 100% removes the entry rather than storing it");
  {
    const t = makeEnv({ "example.com": 0.5 });
    t.tabs.set(1, "https://example.com/x");
    await t.msg({ type: "storeVolume", tabId: 1, value: 1 });
    await wait(320);
    eq("entry deleted", "example.com" in t.stored.siteVolumes, false);
  }

  console.log("\n3. A tab moving to another site drops its override");
  {
    const t = makeEnv({ "quiet.example": 0.1 });
    t.tabs.set(1, "https://loud.example/a");
    await t.msg({ type: "storeVolume", tabId: 1, value: 0.8 });

    // same-site navigation keeps the override
    await t.update(1, { url: "https://loud.example/b" }, { id: 1, url: "https://loud.example/b" });
    t.tabs.set(1, "https://loud.example/b");
    let r = await t.msg({ type: "lookupVolume", tabId: 1 });
    eq("override survives same-site navigation", r.value, 0.8);

    // cross-site navigation drops it and the new site's own level applies
    await t.update(1, { url: "https://quiet.example/z" }, { id: 1, url: "https://quiet.example/z" });
    t.tabs.set(1, "https://quiet.example/z");
    r = await t.msg({ type: "lookupVolume", tabId: 1 });
    eq("new site's stored level applies", r.value, 0.1);
  }

  console.log("\n4. Forget clears the site and resets the tab");
  {
    const t = makeEnv({ "noisy.example": 0.2 });
    t.tabs.set(1, "https://noisy.example/");
    await t.msg({ type: "forgetSite", tabId: 1 });
    await wait(320);
    eq("site entry gone", "noisy.example" in t.stored.siteVolumes, false);
    const reset = t.sent.filter((s) => s.payload.type === "setVolume" && s.payload.value === 1);
    eq("tab reset to 100%", reset.length > 0, true);
  }

  console.log("\n5. Frames are addressed individually");
  {
    const t = makeEnv();
    t.tabs.set(1, "https://site.example/");
    t.sent.length = 0;
    await t.msg({ type: "fanOut", tabId: 1, payload: { type: "setVolume", value: 0.5 } });
    eq("one message per frame", t.sent.map((s) => s.frameId), [0, 1]);
  }

  console.log("\n6. Content scripts in subframes inherit the tab's site");
  {
    const t = makeEnv({ "parent.example": 0.35 });
    // sender.tab.url is the TOP-level URL even for a deeply nested frame
    const r = await t.msg({ type: "requestVolume" },
                          { tab: { id: 9, url: "https://parent.example/game" } });
    eq("nested frame gets the parent site's level", r.value, 0.35);
  }

  console.log("\n7. Storage writes are coalesced");
  {
    const t = makeEnv();
    t.tabs.set(1, "https://drag.example/");
    for (let v = 1; v <= 25; v++) {
      await t.msg({ type: "storeVolume", tabId: 1, value: v / 100 });
    }
    eq("no write yet (still debouncing)", t.writes.length, 0);
    await wait(320);
    eq("25 changes collapsed into one write", t.writes.length, 1);
    eq("last value won", t.stored.siteVolumes["drag.example"], 0.25);
  }

  console.log("\n8. Closing a tab drops its override, not the site memory");
  {
    const t = makeEnv();
    t.tabs.set(1, "https://keep.example/");
    await t.msg({ type: "storeVolume", tabId: 1, value: 0.45 });
    await wait(320);
    t.remove(1);
    t.tabs.set(2, "https://keep.example/other");
    const r = await t.msg({ type: "lookupVolume", tabId: 2 });
    eq("site level survives the tab", r.value, 0.45);
  }

  console.log("\n9. Unparseable and privileged URLs don't crash or get stored");
  {
    const t = makeEnv();
    t.tabs.set(1, "about:debugging");
    const r = await t.msg({ type: "lookupVolume", tabId: 1 });
    eq("no host", r.host, null);
    eq("defaults to 100%", r.value, 1);
    await t.msg({ type: "storeVolume", tabId: 1, value: 0.5 });
    await wait(320);
    eq("nothing stored for a hostless URL", Object.keys(t.stored.siteVolumes), []);
  }


  const ICON_ON    = { 16: "icon-16.png",       32: "icon-32.png",       48: "icon-48.png" };
  const ICON_MUTED = { 16: "icon-muted-16.png", 32: "icon-muted-32.png", 48: "icon-muted-48.png" };

  console.log("\n10. Muting shows a mute icon, not a number on a red badge");
  {
    const t = makeEnv();
    t.tabs.set(1, "https://loud.example/");

    await t.msg({ type: "storeVolume", tabId: 1, value: 0 });
    eq("0% swaps in the muted icon", t.lastIcon(), ICON_MUTED);
    eq("0% shows no badge number", t.lastBadge(), "");
    eq("0% says so in the tooltip", t.lastTitle(), "Gainshift - muted");

    await t.msg({ type: "storeVolume", tabId: 1, value: 0.5 });
    eq("50% shows the number", t.lastBadge(), "50");
    eq("50% badge is the normal colour", t.lastColor(), "#1d4ed8");
    eq("50% tooltip carries the level", t.lastTitle(), "Gainshift - 50%");

    await t.msg({ type: "storeVolume", tabId: 1, value: 1 });
    eq("100% shows no badge", t.lastBadge(), "");
    eq("100% tooltip is just the name", t.lastTitle(), "Gainshift");

    await t.msg({ type: "storeVolume", tabId: 1, value: 2.5 });
    eq("boost shows the number", t.lastBadge(), "250");
    eq("boost badge is the warning colour", t.lastColor(), "#b45309");
    eq("boost is not the muted icon", t.lastIcon(), ICON_ON);
  }

  console.log("\n11. Coming back up from 0 restores the speaker icon");
  {
    // The failure this pins: setting the muted icon on the way down but never
    // setting it back, so the tab stays marked muted while audio is playing.
    // Every route out of 0 is checked, because each one is a separate call site.
    const t = makeEnv();
    t.tabs.set(1, "https://loud.example/");

    await t.msg({ type: "storeVolume", tabId: 1, value: 0 });
    await t.msg({ type: "storeVolume", tabId: 1, value: 0.6 });
    eq("raising the level restores the icon", t.lastIcon(), ICON_ON);

    await t.msg({ type: "storeVolume", tabId: 1, value: 0 });
    await t.msg({ type: "forgetSite", tabId: 1 });
    eq("Forget restores the icon", t.lastIcon(), ICON_ON);

    // ...and a muted tab navigating to a site with no stored level.
    const u = makeEnv();
    u.tabs.set(2, "https://muted.example/");
    await u.msg({ type: "storeVolume", tabId: 2, value: 0 });
    eq("still muted before navigating", u.lastIcon(), ICON_MUTED);
    await u.update(2, { url: "https://fresh.example/" }, { id: 2, url: "https://fresh.example/" });
    await u.update(2, { status: "complete" }, { id: 2, url: "https://fresh.example/" });
    eq("navigating away restores the icon", u.lastIcon(), ICON_ON);
  }

  console.log("\n12. A toolbar call that rejects doesn't surface as an error");
  {
    // A tab closing between the volume change and the toolbar update makes every
    // browserAction call reject. try/catch does not catch a rejected promise.
    const t = makeEnv({}, { toolbarFails: true });
    t.tabs.set(1, "https://closing.example/");
    const r = await t.msg({ type: "storeVolume", tabId: 1, value: 0 });
    eq("the volume change still succeeds", r.ok, true);
    eq("the toolbar was still asked", t.icons.length > 0, true);
    await wait(30);
    eq("no unhandled promise rejection", unhandled, []);
  }


  console.log("\n13. Every icon the code asks for is a file the build ships");
  {
    // A typo in an icon path is invisible in Node and invisible in review: the
    // toolbar just silently keeps the previous icon. So check the paths the code
    // actually passed to setIcon against the disk and against build.sh's
    // packaged file list, which is the only place that list exists.
    const t = makeEnv();
    t.tabs.set(1, "https://x.example/");
    await t.msg({ type: "storeVolume", tabId: 1, value: 0 });    // muted set
    await t.msg({ type: "storeVolume", tabId: 1, value: 0.5 });  // normal set

    const used = [...new Set(t.icons.flatMap((o) => Object.values(o.path)))].sort();
    eq("both icon sets were exercised", used.length, 6);

    const build = fs.readFileSync(path.join(__dirname, "build.sh"), "utf8");
    const packaged = new Set(
      build.split(/FILES="/)[1].split('"')[0].split("\n").map((x) => x.trim()).filter(Boolean)
    );

    const onDisk = used.filter((f) => fs.existsSync(path.join(__dirname, f)));
    eq("all exist on disk", onDisk, used);
    eq("all are in the packaged list", used.filter((f) => packaged.has(f)), used);
  }


  console.log("\n14. A content script cannot reach the privileged message types");
  {
    // The popup has no sender.tab; a content script always has one. Nothing here
    // sends these from a frame today - this shuts the door before some later
    // change opens it.
    const t = makeEnv({ "victim.example": 0.4 });
    t.tabs.set(1, "https://victim.example/");
    const frame = { tab: { id: 1, url: "https://victim.example/" } };

    eq("storeVolume from a frame is ignored",
       await t.msg({ type: "storeVolume", tabId: 1, value: 0.01 }, frame), undefined);
    eq("forgetSite from a frame is ignored",
       await t.msg({ type: "forgetSite", tabId: 1 }, frame), undefined);
    eq("fanOut from a frame is ignored",
       await t.msg({ type: "fanOut", tabId: 1, payload: { type: "setVolume", value: 0 } }, frame), undefined);
    eq("resetTab from a frame is ignored",
       await t.msg({ type: "resetTab", tabId: 1 }, frame), undefined);

    await wait(320);
    eq("the stored level was not touched", t.stored.siteVolumes["victim.example"], 0.4);

    // ...and the frame's own legitimate message still works.
    const r = await t.msg({ type: "requestVolume" }, frame);
    eq("requestVolume from a frame still answers", r.value, 0.4);

    // ...and the popup, which has no tab, is unaffected.
    await t.msg({ type: "storeVolume", tabId: 1, value: 0.2 }, {});
    await wait(320);
    eq("the popup can still set a level", t.stored.siteVolumes["victim.example"], 0.2);
  }

  console.log("\n15. A host named __proto__ is stored like any other");
  {
    // Hostnames are used as object keys, and "__proto__" is a legal hostname.
    // On a normal object, assigning a number to it is a silent no-op, so the
    // level simply vanished. A null-prototype store has no such special key.
    const t = makeEnv();
    t.tabs.set(1, "http://__proto__/");
    await t.msg({ type: "storeVolume", tabId: 1, value: 0.45 }, {});
    await wait(320);
    eq("the level was actually stored", t.stored.siteVolumes["__proto__"], 0.45);

    const r = await t.msg({ type: "lookupVolume", tabId: 2 }, {});
    eq("nothing leaked onto other lookups", r.value, 1);

    t.tabs.set(3, "http://__proto__/other");
    const r3 = await t.msg({ type: "lookupVolume", tabId: 3 }, {});
    eq("and it reads back for that host", r3.value, 0.45);
    eq("reported as remembered", r3.remembered, true);
    eq("Object.prototype is untouched", ({}).__lint === undefined, true);
  }


  console.log("\n16. A tab-scoped level never reaches storage");
  {
    const t = makeEnv();
    t.tabs.set(1, "https://youtube.com/watch");

    await t.set(1, 0.3, "tab");
    await wait(320);
    eq("nothing was written", t.writes.length, 0);
    eq("nothing is stored for the site", Object.keys(t.stored.siteVolumes), []);
    eq("but the tab is at the level", (await t.look(1)).value, 0.3);
    eq("...and says so", (await t.look(1)).scope, "tab");

    // site scope still behaves exactly as it always did
    await t.set(1, 0.45, "site");
    await wait(320);
    eq("site scope still stores", t.stored.siteVolumes["youtube.com"], 0.45);
    eq("...and says so", (await t.look(1)).scope, "site");

    // and the default, when no scope is given at all, is still "site"
    const u = makeEnv();
    u.tabs.set(1, "https://old.example/");
    await u.set(1, 0.2);
    await wait(320);
    eq("no scope given means site, as before", u.stored.siteVolumes["old.example"], 0.2);
  }

  console.log("\n17. Two tabs on one site, two different levels");
  {
    // The case this feature exists for: two slot games on one casino. Same
    // host, same path shape, two tabs, two levels, nothing saved.
    const t = makeEnv();
    t.tabs.set(1, "https://rainbet.com/casino/game-a");
    t.tabs.set(2, "https://rainbet.com/casino/game-b");

    await t.set(1, 0.3, "tab");
    await t.set(2, 0.6, "tab");
    await wait(320);

    eq("tab 1 holds its own level", (await t.look(1)).value, 0.3);
    eq("tab 2 holds a different one", (await t.look(2)).value, 0.6);
    eq("the site itself is untouched", Object.keys(t.stored.siteVolumes), []);

    // a third tab on the same site gets the site default, not either of them
    t.tabs.set(3, "https://rainbet.com/casino/game-c");
    eq("a new tab is unaffected by both", (await t.look(3)).value, 1);
  }

  console.log("\n18. A tab-scoped level is dropped with the tab");
  {
    const t = makeEnv({ "keep.example": 0.4 });
    t.tabs.set(1, "https://keep.example/");

    // closing
    await t.set(1, 0.1, "tab");
    t.remove(1);
    t.tabs.set(1, "https://keep.example/other");
    eq("a reused tab id inherits nothing", (await t.look(1)).value, 0.4);
    eq("...including the scope", (await t.look(1)).scope, "site");

    // navigating to another site
    await t.set(1, 0.1, "tab");
    await t.update(1, { url: "https://elsewhere.example/" }, { id: 1, url: "https://elsewhere.example/" });
    t.tabs.set(1, "https://elsewhere.example/");
    eq("navigating away drops it", (await t.look(1)).value, 1);
    eq("...and the scope with it", (await t.look(1)).scope, "site");

    // Forget
    t.tabs.set(2, "https://keep.example/");
    await t.set(2, 0.1, "tab");
    await t.msg({ type: "forgetSite", tabId: 2 }, {});
    eq("Forget drops the tab level too", (await t.look(2)).value, 1);
    eq("...and the scope", (await t.look(2)).scope, "site");
  }

  console.log("\n19. The panel is told what the site would still be");
  {
    const t = makeEnv({ "youtube.com": 0.45 });
    t.tabs.set(1, "https://youtube.com/watch");
    await t.set(1, 0.9, "tab");
    const r = await t.look(1);
    eq("the tab's own level", r.value, 0.9);
    eq("the site's level, for the panel to show", r.siteValue, 0.45);
    eq("still remembered", r.remembered, true);
    eq("scope reported", r.scope, "tab");

    const u = makeEnv();
    u.tabs.set(1, "https://fresh.example/");
    const r2 = await u.look(1);
    eq("no stored level reads as null, not 1", r2.siteValue, null);
  }

  console.log("\n20. The keyboard steps by 5 and never writes to storage");
  {
    const t = makeEnv({ "youtube.com": 0.5 });
    t.tabs.set(1, "https://youtube.com/watch");
    t.activate(1);

    await t.key("volume-up");
    eq("up goes +5 points from the site level", (await t.look(1)).value, 0.55);
    // The maps agreeing is not the point of a keystroke - the sound changing is.
    eq("and the frames were told so", t.lastPushed(), 0.55);
    await t.key("volume-up");
    eq("and again", (await t.look(1)).value, 0.6);
    eq("frames told again", t.lastPushed(), 0.6);
    await t.key("volume-down");
    eq("down goes -5", (await t.look(1)).value, 0.55);
    eq("frames told the lower level", t.lastPushed(), 0.55);
    eq("every frame in the tab, not just the top one",
       t.sent.filter((s) => s.payload.type === "setVolume" && s.payload.value === 0.55).length, 4);

    await wait(320);
    eq("NOTHING was written to storage", t.writes.length, 0);
    eq("the site level is exactly as it was", t.stored.siteVolumes["youtube.com"], 0.5);
    eq("the tab is marked tab-scoped", (await t.look(1)).scope, "tab");
  }

  console.log("\n21. Steps clamp, and land on whole percentage points");
  {
    const t = makeEnv({ "x.example": 0.7 });
    t.tabs.set(1, "https://x.example/");
    t.activate(1);
    await t.key("volume-up");
    // 0.7 + 0.05 is 0.7500000000000001 in binary floating point.
    eq("no floating-point dust", (await t.look(1)).value, 0.75);

    const lo = makeEnv();
    lo.tabs.set(1, "https://lo.example/");
    lo.activate(1);
    await lo.set(1, 0.02, "tab");
    await lo.key("volume-down");
    eq("stops at zero", (await lo.look(1)).value, 0);
    await lo.key("volume-down");
    eq("and stays there", (await lo.look(1)).value, 0);

    const hi = makeEnv();
    hi.tabs.set(1, "https://hi.example/");
    hi.activate(1);
    await hi.set(1, 5.98, "tab");
    await hi.key("volume-up");
    eq("stops at 600%", (await hi.look(1)).value, 6);
    await hi.key("volume-up");
    eq("and stays there", (await hi.look(1)).value, 6);
  }

  console.log("\n22. Reset puts the tab at 100% without touching the site");
  {
    // The YouTube case: a video was quiet, it got boosted, the next one is not.
    // One key and this tab is at plain 100% - and only this tab.
    const t = makeEnv({ "youtube.com": 0.45 });
    t.tabs.set(1, "https://youtube.com/watch");
    t.activate(1);

    await t.set(1, 2, "tab");
    eq("boosted for the quiet video", (await t.look(1)).value, 2);

    await t.key("volume-reset");
    eq("straight to 100%", (await t.look(1)).value, 1);
    // Asking the maps is not enough: reset computes the level a second time for
    // the frames and the toolbar, and those are what the user hears and sees.
    eq("the audio is told 100%", t.lastPushed(), 1);
    eq("the badge clears at 100%", t.lastBadge(), "");
    eq("and so does the tooltip", t.lastTitle(), "Gainshift");

    // The whole point of doing it tab-scoped: a level the user deliberately
    // saved for the site must survive a reset in one tab.
    eq("the tab is held apart from its site", (await t.look(1)).scope, "tab");
    await wait(320);
    eq("storage was never touched", t.writes.length, 0);
    eq("the site keeps its 45%", t.stored.siteVolumes["youtube.com"], 0.45);
    eq("and the panel still reports it", (await t.look(1)).siteValue, 0.45);

    // a second tab on the same site is unaffected
    t.tabs.set(2, "https://youtube.com/watch?v=other");
    eq("another tab still opens at the site's level", (await t.look(2)).value, 0.45);

    // and the tab itself goes back to the site's level once it moves on
    t.tabs.set(1, "https://elsewhere.example/");
    t.update(1, { url: "https://elsewhere.example/" }, { url: "https://elsewhere.example/" });
    t.tabs.set(1, "https://youtube.com/watch");
    t.update(1, { url: "https://youtube.com/watch" }, { url: "https://youtube.com/watch" });
    eq("coming back to the site, 45% again", (await t.look(1)).value, 0.45);

    // with nothing saved for the site it is still just 100%
    const u = makeEnv();
    u.tabs.set(1, "https://plain.example/");
    u.activate(1);
    await u.set(1, 3, "tab");
    await u.key("volume-reset");
    eq("no site level, still 100%", (await u.look(1)).value, 1);

    // resetting an untouched tab is harmless
    await u.key("volume-reset");
    eq("resetting twice is a no-op", (await u.look(1)).value, 1);

    // unmute after a reset comes back to 100%, not to the pre-reset boost
    await u.key("volume-mute");
    eq("muted", (await u.look(1)).value, 0);
    await u.key("volume-mute");
    eq("unmutes to 100%, not to the old 300%", (await u.look(1)).value, 1);
  }

  console.log("\n23. Mute toggles back to where it was, not to 100%");
  {
    const t = makeEnv();
    t.tabs.set(1, "https://m.example/");
    t.activate(1);

    await t.set(1, 0.3, "tab");
    await t.key("volume-mute");
    eq("muted", (await t.look(1)).value, 0);
    eq("icon shows muted", t.lastIcon()["16"], "icon-muted-16.png");
    await t.key("volume-mute");
    eq("unmuted to the level it had", (await t.look(1)).value, 0.3);

    // a tab that was never adjusted: the level comes from the site
    const u = makeEnv({ "s.example": 0.4 });
    u.tabs.set(1, "https://s.example/");
    u.activate(1);
    await u.key("volume-mute");
    eq("muted from the site's level", (await u.look(1)).value, 0);
    await u.key("volume-mute");
    eq("unmuted back to the SITE's level", (await u.look(1)).value, 0.4);
    await wait(320);
    eq("and none of that was stored", u.writes.length, 0);

    // muted with nothing to go back to
    const v = makeEnv({ "z.example": 0 });
    v.tabs.set(1, "https://z.example/");
    v.activate(1);
    await v.key("volume-mute");
    eq("unmuting with no history gives 100%", (await v.look(1)).value, 1);
  }

  console.log("\n24. A keystroke with no active tab does nothing");
  {
    const t = makeEnv();
    t.tabs.set(1, "https://x.example/");
    // deliberately not activated
    await t.key("volume-up");
    await t.key("volume-reset");
    await t.key("volume-mute");
    eq("no crash, nothing stored", t.writes.length, 0);
    eq("no unhandled rejection", unhandled, []);

    // and an unknown command name is ignored
    t.activate(1);
    await t.key("some-other-addons-command");
    eq("an unknown command is ignored", (await t.look(1)).value, 1);
  }

  console.log("\n25. A level set on a page with no host does not follow the tab");
  {
    // The new-tab page, file:// and about:blank have no hostname. A level set
    // there was carried to the next real site, because the cross-site check only
    // fired when the previous host was truthy - and null is not.
    const t = makeEnv();
    t.tabs.set(1, "about:newtab");
    await t.update(1, { url: "about:newtab" }, { id: 1, url: "about:newtab" });
    t.activate(1);
    await t.key("volume-mute");
    eq("muted on the new-tab page", (await t.look(1)).value, 0);

    t.tabs.set(1, "https://youtube.com/watch");
    await t.update(1, { url: "https://youtube.com/watch" }, { id: 1, url: "https://youtube.com/watch" });
    eq("the first real site opens at its own level", (await t.look(1)).value, 1);
    const r = await t.msg({ type: "requestVolume" },
                          { tab: { id: 1, url: "https://youtube.com/watch" } });
    eq("and its frames are told the same", r.value, 1);
    eq("and it is not left tab-scoped", (await t.look(1)).scope, "site");

    // The panel on a file:// page, in a tab whose navigation was never seen
    // (it was already open when the extension loaded).
    const u = makeEnv({ "news.example": 0.6 });
    u.tabs.set(2, "file:///C:/music/test.html");
    await u.set(2, 3);
    u.tabs.set(2, "https://news.example/");
    await u.update(2, { url: "https://news.example/" }, { id: 2, url: "https://news.example/" });
    eq("300% on a file:// page does not reach the next site", (await u.look(2)).value, 0.6);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  // Without this the suite dies silently: the unhandledRejection recorder above
  // captures the crash and nothing is ever printed.
  console.log("\n  SUITE CRASHED\n");
  console.log(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
