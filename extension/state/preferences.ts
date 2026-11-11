import { createStore } from "zustand/vanilla";
import { persist, type PersistStorage } from "zustand/middleware";

interface Preferences {
  model: string;
  setModel: (model: string) => Promise<void>;
}

// Keep the existing storage key and format so saved choices survive upgrades.
export function createPreferencesStore() {
  const storage: PersistStorage<Pick<Preferences, "model">> = {
    async getItem(name) {
      const data = await browser.storage.local.get(name);
      return {
        state: { model: typeof data[name] === "string" ? data[name] : "" },
        version: 0,
      };
    },
    async setItem(name, value) {
      await browser.storage.local.set({ [name]: value.state.model });
    },
    async removeItem(name) {
      await browser.storage.local.remove(name);
    },
  };
  const store = createStore<Preferences>()(
    persist(
      (set) => ({
        model: "",
        setModel: async (model) => {
          await set({ model });
        },
      }),
      {
        name: "selectedModel",
        storage,
        partialize: ({ model }) => ({ model }),
        skipHydration: true,
      },
    ),
  );
  const subscribe = store.subscribe;
  let subscribers = 0;
  const rehydrate = () => void store.persist.rehydrate();
  const receive = (
    changes: Record<string, browser.storage.StorageChange>,
    area: string,
  ) => {
    if (area === "local" && changes.selectedModel) rehydrate();
  };
  // Zustand's React subscription owns the listener, including unmount cleanup.
  store.subscribe = (listener) => {
    const unsubscribe = subscribe(listener);
    if (subscribers++ === 0) {
      browser.storage.onChanged.addListener(receive);
      rehydrate();
    }
    return () => {
      unsubscribe();
      if (--subscribers === 0)
        browser.storage.onChanged.removeListener(receive);
    };
  };
  return store;
}
