import { createStore } from "zustand/vanilla";
import { record } from "../auth/protocol";
import type { ModelChoice } from "./scraper";

interface Account {
  clientId: string;
  subject: string;
  email?: string;
}
interface SettingsState {
  configured: boolean;
  locked: boolean;
  signedIn: boolean;
  pending: boolean;
  account?: Account;
  registrations: Account[];
  notice: string;
  output: string;
  models: ModelChoice[];
  model: string;
  running: ReadonlySet<string>;
}
function account(value: unknown): Account | undefined {
  if (
    !record(value) ||
    typeof value.clientId !== "string" ||
    typeof value.subject !== "string"
  )
    return;
  return {
    clientId: value.clientId,
    subject: value.subject,
    ...(typeof value.email === "string" ? { email: value.email } : {}),
  };
}
export function createSettingsStore() {
  const store = createStore<SettingsState>()(() => ({
    configured: false,
    locked: false,
    signedIn: false,
    pending: false,
    registrations: [],
    notice: "Loading…",
    output: "",
    models: [],
    model: "",
    running: new Set(),
  }));
  return {
    ...store,
    // Explicit projection: never put a whole background response or credentials in UI state.
    receiveStatus(data: Record<string, unknown>) {
      const signedIn = data.signedIn === true;
      store.setState({
        configured: data.configured === true,
        locked: data.locked === true,
        signedIn,
        pending: data.pending === true,
        account: account(data.account),
        registrations: Array.isArray(data.registrations)
          ? data.registrations.flatMap((value) => {
              const parsed = account(value);
              return parsed ? [parsed] : [];
            })
          : [],
        notice: typeof data.notice === "string" ? data.notice : "",
        ...(!signedIn ? { models: [], model: "" } : {}),
      });
    },
    begin(id: string) {
      if (store.getState().running.has(id)) return false;
      store.setState((state) => ({ running: new Set([...state.running, id]) }));
      return true;
    },
    finish(id: string) {
      store.setState((state) => ({
        running: new Set([...state.running].filter((key) => key !== id)),
      }));
    },
  };
}
