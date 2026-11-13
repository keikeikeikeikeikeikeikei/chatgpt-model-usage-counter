"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/background.js"), "utf8");

function harness(initialSettings, fetchImpl) {
  const listeners = {};
  const stored = {};
  if (initialSettings) stored.chatgptModelUsageSettings = initialSettings;
  const calls = { urls: [], created: [], cleared: [], colors: [], titles: [], badges: [] };
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { listeners.message = fn; } },
      onInstalled: { addListener(fn) { listeners.installed = fn; } },
      onStartup: { addListener(fn) { listeners.startup = fn; } }
    },
    alarms: {
      create(name, options) { calls.created.push({ name, options }); },
      clear(name) { calls.cleared.push(name); },
      onAlarm: { addListener(fn) { listeners.alarm = fn; } }
    },
    storage: {
      local: {
        get(keys, fn) {
          const found = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            if (Object.prototype.hasOwnProperty.call(stored, key)) found[key] = stored[key];
          }
          setImmediate(() => fn(found));
        },
        set(data, fn) {
          Object.assign(stored, data);
          setImmediate(() => fn && fn());
        }
      }
    },
    action: {
      setBadgeText({ text }) { calls.badges.push(text); },
      setBadgeBackgroundColor({ color }) { calls.colors.push(color); },
      setBadgeTextColor() {},
      setTitle({ title }) { calls.titles.push(title); },
      setIcon() {}
    }
  };
  const ctx = {
    chrome,
    fetch(url, options) {
      calls.urls.push(url);
      return (fetchImpl || (() => Promise.resolve({ ok: true, json: async () => ({
        status: { indicator: "major_outage", description: "Major outage" },
        components: [{ id: "chatgpt", name: "ChatGPT", status: "major_outage", position: 1 }]
      }) })))(url, options);
    },
    Date, Math, Number, Object, String, Array, Promise, URL, AbortController,
    setTimeout, clearTimeout
  };
  ctx.ChatGPTUsageDates = require("../src/date-utils");
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  const api = ctx.ChatGPTUsageBackground;
  async function settle() {
    await new Promise((done) => setTimeout(done, 25));
  }
  function message(value) {
    return new Promise((resolve) => listeners.message(value, {}, resolve));
  }
  return { listeners, stored, calls, api, message, settle };
}

test("status API polling is off by default, including on boot, startup, and alarm", async () => {
  const h = harness();
  await h.settle();
  assert.equal(h.api.sanitizeSettings({}).openAIStatusMonitoring, false);
  assert.equal(h.calls.urls.length, 0);
  assert.equal(h.calls.created.length, 0);
  assert.ok(h.calls.cleared.includes(h.api.STATUS_ALARM_NAME));
  h.listeners.installed();
  h.listeners.startup();
  h.listeners.alarm({ name: h.api.STATUS_ALARM_NAME });
  await h.settle();
  assert.equal(h.calls.urls.length, 0);
  const status = await h.message({ type: "openai.status.get", cached: false });
  assert.equal(status.ok, false);
  assert.equal(status.error, "status-monitoring-disabled");
  assert.equal(h.calls.urls.length, 0);
  assert.equal(h.calls.colors.at(-1), "#2563eb");
});

test("opt-in starts 5-minute checks; opt-out clears alarms and restores usage-only color", async () => {
  const h = harness();
  await h.settle();
  const enabled = await h.message({ type: "settings.set", settings: { openAIStatusMonitoring: true } });
  assert.equal(enabled.settings.openAIStatusMonitoring, true);
  await h.settle();
  assert.ok(h.calls.created.some((a) => a.name === h.api.STATUS_ALARM_NAME && a.options.periodInMinutes === 5));
  assert.ok(h.calls.urls.some((url) => url.endsWith("/summary.json")));
  assert.ok(h.calls.urls.some((url) => url.endsWith("/components.json")));
  assert.equal(h.calls.colors.at(-1), "#dc2626");
  const callsBeforeAlarm = h.calls.urls.length;
  h.listeners.alarm({ name: h.api.STATUS_ALARM_NAME });
  await h.settle();
  assert.ok(h.calls.urls.length > callsBeforeAlarm);
  const disabled = await h.message({ type: "settings.set", settings: { openAIStatusMonitoring: false } });
  assert.equal(disabled.settings.openAIStatusMonitoring, false);
  await h.settle();
  assert.ok(h.calls.cleared.includes(h.api.STATUS_ALARM_NAME));
  assert.equal(h.calls.colors.at(-1), "#2563eb");
  assert.doesNotMatch(h.calls.titles.at(-1), /OpenAI status/);
  const callsAfterDisable = h.calls.urls.length;
  h.listeners.alarm({ name: h.api.STATUS_ALARM_NAME });
  h.listeners.installed();
  h.listeners.startup();
  await h.settle();
  assert.equal(h.calls.urls.length, callsAfterDisable);
  const blocked = await h.message({ type: "openai.status.get", cached: false });
  assert.equal(blocked.error, "status-monitoring-disabled");
  assert.equal(h.calls.urls.length, callsAfterDisable);
});

test("disabling during an outstanding status request never restores warning colors", async () => {
  const pending = [];
  const h = harness(null, () => new Promise((resolve) => pending.push(resolve)));
  await h.settle();
  await h.message({ type: "settings.set", settings: { openAIStatusMonitoring: true } });
  await h.settle();
  assert.equal(pending.length, 2);
  await h.message({ type: "settings.set", settings: { openAIStatusMonitoring: false } });
  await h.settle();
  for (const resolve of pending) {
    resolve({ ok: true, json: async () => ({ status: { indicator: "major_outage" }, components: [] }) });
  }
  await h.settle();
  assert.equal(h.calls.colors.at(-1), "#2563eb");
  assert.doesNotMatch(h.calls.titles.at(-1), /OpenAI status/);
  assert.equal(h.calls.urls.length, 2);
});
