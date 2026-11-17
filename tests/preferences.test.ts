import type { MockData, MockCallback } from "./mock-types.ts";
import { assert, test } from "vitest";
import { createPreferencesStore } from "../extension/state/preferences.ts";

test("persist hydrates, saves, syncs open stores, restores after restart, and cleans up listeners", async () => {
  const listeners = new Set<MockCallback>();
  const data: Record<string, string> = { selectedModel: "saved" };
  const original = globalThis.browser;
  globalThis.browser = {
    storage: {
      local: {
        get: async () => ({ ...data }),
        async set(update: MockData) {
          Object.assign(data, update);
          for (const listener of listeners)
            listener(
              { selectedModel: { newValue: data.selectedModel } },
              "local",
            );
        },
        async remove(name: string) {
          delete data[name];
          for (const listener of listeners)
            listener({ selectedModel: {} }, "local");
        },
      },
      onChanged: {
        addListener: (listener: MockCallback) => listeners.add(listener),
        removeListener: (listener: MockCallback) => listeners.delete(listener),
      },
    },
  } as unknown as typeof browser;
  const cleanup: (() => void)[] = [];
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
    assert.strictEqual(settings.getState().model, "saved");
    assert.strictEqual(sidebar.getState().model, "saved");
    await settings.getState().setModel("chosen");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(data.selectedModel, "chosen");
    assert.strictEqual(sidebar.getState().model, "chosen");
    const restarted = createPreferencesStore();
    await restarted.persist.rehydrate();
    assert.strictEqual(restarted.getState().model, "chosen");
    await settings.persist.clearStorage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(sidebar.getState().model, "");
  } finally {
    cleanup.forEach((unsubscribe) => unsubscribe());
    globalThis.browser = original;
  }
  assert.strictEqual(listeners.size, 0);
});
