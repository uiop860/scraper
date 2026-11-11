import assert from "node:assert/strict";
import { test } from "node:test";
import { bundle } from "./helpers.mjs";
const { createPreferencesStore } = await import(
  await bundle("extension/state/preferences.ts")
);

test("persist hydrates, saves, syncs open stores, restores after restart, and cleans up listeners", async () => {
  const listeners = new Set();
  const data = { selectedModel: "saved" };
  const original = globalThis.browser;
  globalThis.browser = {
    storage: {
      local: {
        get: async () => ({ ...data }),
        async set(update) {
          Object.assign(data, update);
          for (const listener of listeners)
            listener(
              { selectedModel: { newValue: data.selectedModel } },
              "local",
            );
        },
        async remove(name) {
          delete data[name];
          for (const listener of listeners)
            listener({ selectedModel: {} }, "local");
        },
      },
      onChanged: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },
    },
  };
  const cleanup = [];
  try {
    const settings = createPreferencesStore();
    const sidebar = createPreferencesStore();
    cleanup.push(
      settings.subscribe(() => {}),
      sidebar.subscribe(() => {}),
    );
    await Promise.all([
      settings.persist.rehydrate(),
      sidebar.persist.rehydrate(),
    ]);
    assert.equal(settings.getState().model, "saved");
    assert.equal(sidebar.getState().model, "saved");
    await settings.getState().setModel("chosen");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(data.selectedModel, "chosen");
    assert.equal(sidebar.getState().model, "chosen");
    const restarted = createPreferencesStore();
    await restarted.persist.rehydrate();
    assert.equal(restarted.getState().model, "chosen");
    await settings.persist.clearStorage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sidebar.getState().model, "");
  } finally {
    cleanup.forEach((unsubscribe) => unsubscribe());
    globalThis.browser = original;
  }
  assert.equal(listeners.size, 0);
});
