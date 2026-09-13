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
  let onMessage = null, onUpdated = null, onRemoved = null;

  const browser = {
    storage: {
      local: {
        get: async () => JSON.parse(JSON.stringify(stored)),
        set: (o) => { writes.push(JSON.parse(JSON.stringify(o))); Object.assign(stored, o); },
      },
    },
    tabs: {
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
    msg: (m, sender) => onMessage(m, sender || {}),
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

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
