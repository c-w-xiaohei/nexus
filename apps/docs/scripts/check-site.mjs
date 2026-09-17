import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { load } from "cheerio";
import { staticClient } from "fumadocs-core/search/client/orama-static";

const html = load(await readFile("dist/index.html", "utf8"));
const bootstrap = html("script")
  .toArray()
  .map((node) => html(node).html())
  .find((script) => script.includes('localStorage.getItem("theme")'));
assert.ok(
  bootstrap,
  "Built homepage must initialize its theme before hydration",
);

function themeEnvironment(stored, systemDark, storageAvailable = true) {
  const classes = new Set();
  const events = new Map();
  const media = {
    matches: systemDark,
    addEventListener: (key, fn) => events.set(`media:${key}`, fn),
  };
  let observer;
  let color;
  const root = {
    classList: {
      contains: (name) => classes.has(name),
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
        observer?.();
      },
    },
    style: {},
  };
  runInNewContext(bootstrap, {
    document: {
      documentElement: root,
      querySelector: () => ({
        setAttribute: (_, value) => {
          color = value;
        },
      }),
    },
    window: {
      matchMedia: () => media,
      addEventListener: (key, fn) => events.set(key, fn),
    },
    localStorage: {
      getItem() {
        if (!storageAvailable) throw new Error("Storage unavailable");
        return stored;
      },
    },
    MutationObserver: class {
      constructor(callback) {
        observer = callback;
      }
      observe() {}
    },
  });
  return {
    classes,
    root,
    media,
    events,
    color: () => color,
    setStored: (value) => {
      stored = value;
    },
  };
}

test("explicit theme wins over system and initializes browser chrome", () => {
  for (const [stored, systemDark, expected] of [
    ["dark", false, "dark"],
    ["light", true, "light"],
  ]) {
    const env = themeEnvironment(stored, systemDark);
    assert.ok(env.classes.has(expected));
    assert.equal(env.root.style.colorScheme, expected);
    assert.equal(env.color(), expected === "dark" ? "#090c0b" : "#fafbf5");
  }
});

test("system theme follows OS changes and cross-tab preferences", () => {
  const env = themeEnvironment("system", false);
  assert.ok(env.classes.has("light"));
  env.media.matches = true;
  env.events.get("media:change")();
  assert.ok(env.classes.has("dark"));
  env.setStored("light");
  env.events.get("storage")({ key: "theme" });
  assert.ok(env.classes.has("light"));
  assert.equal(env.color(), "#fafbf5");
});

test("theme works when browser storage is unavailable", () => {
  assert.ok(themeEnvironment(null, true, false).classes.has("dark"));
});

test("exported static search respects the selected language", async () => {
  const data = await readFile("dist/api/search.json", "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(data);
  try {
    const en = await staticClient({ from: "site-check", locale: "en" }).search(
      "connection",
    );
    assert.ok(en.length > 0);
    assert.ok(
      en.every((result) => !result.url.startsWith("/nexus/docs/zh-CN/")),
    );
    const zh = await staticClient({
      from: "site-check",
      locale: "zh-CN",
    }).search("连接");
    if (data.includes("/nexus/docs/zh-CN/"))
      assert.ok(zh.length > 0, "Chinese content must be searchable");
    assert.ok(
      zh.every((result) => result.url.startsWith("/nexus/docs/zh-CN/")),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
