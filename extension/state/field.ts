import type { StoreApi } from "zustand/vanilla";

// React-compatible field setters keep functional updates on the current snapshot.
export function storeField<T, K extends keyof T>(store: StoreApi<T>, key: K) {
  return (next: T[K] | ((previous: T[K]) => T[K])) => {
    const value =
      typeof next === "function"
        ? (next as (previous: T[K]) => T[K])(store.getState()[key])
        : next;
    store.setState((state) => ({ ...state, [key]: value }));
  };
}
