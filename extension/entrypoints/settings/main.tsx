import "./style.css";
import { useStore } from "zustand";
import { createSettingsStore } from "../../state/settings";
import { storeField } from "../../state/field";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { mountPage } from "../../ui/root";
import { record } from "../../auth/protocol";

type Account = { clientId: string; label: string };
type AccountStatus = {
  configured: boolean;
  locked: boolean;
  signedIn: boolean;
  pending: boolean;
  description: string;
  registrations: Account[];
};
async function send(message: object) {
  const result: unknown = await browser.runtime.sendMessage(message);
  if (!record(result))
    throw new Error("Extension unavailable. Reload this page.");
  if (!result.ok)
    throw new Error(
      typeof result.error === "string" ? result.error : "Request failed.",
    );
  return result;
}

function Settings() {
  const [store] = useState(createSettingsStore);
  const state = useStore(store);
  const { output, models, model, running } = state;
  const status: AccountStatus = {
    ...state,
    registrations: state.registrations.map((r) => ({
      clientId: r.clientId,
      label: `${r.email ?? r.subject} (${r.clientId.slice(-8)})`,
    })),
    description:
      state.notice === "Loading…"
        ? "Loading…"
        : `${state.signedIn ? `Signed in: ${state.account?.email ?? state.account?.subject}` : state.locked ? "Saved sign-in locked" : "Signed out"}. ${state.notice}`,
  };
  const setOutput = storeField(store, "output");
  const setModels = storeField(store, "models");
  const setModel = storeField(store, "model");
  const [account, setAccount] = useState("");
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const live = useRef(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const data = await send({ type: "status" });
    if (!live.current || request !== sequence.current) return;
    store.receiveStatus(data);
    const registrations = store.getState().registrations;
    setAccount((selected) =>
      registrations.some((item) => item.clientId === selected) ? selected : "",
    );
  }, [store]);

  useEffect(() => {
    live.current = true;
    void refresh().catch(() => {
      if (live.current)
        store.setState({ notice: "Extension unavailable. Reload this page." });
    });
    const interval = setInterval(() => {
      void refresh().catch(() => {});
    }, 2000);
    function cleanup() {
      live.current = false;
      clearInterval(interval);
      window.removeEventListener("pagehide", cleanup);
    }
    window.addEventListener("pagehide", cleanup);
    return cleanup;
  }, [refresh, store]);

  async function action(name: string, work: () => Promise<unknown>) {
    if (!store.begin(name)) return;
    try {
      await work();
    } catch (error) {
      if (live.current)
        setOutput(error instanceof Error ? error.message : "Request failed.");
    } finally {
      store.finish(name);
      if (live.current) {
        await refresh().catch(() => {});
      }
    }
  }
  function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (store.getState().running.has("unlock")) return;
    if (!status.configured && pin !== confirmation) {
      setOutput("PINs do not match.");
      return;
    }
    const value = pin;
    setPin("");
    setConfirmation("");
    void action("unlock", () => send({ type: "unlock", pin: value }));
  }
  function reset(name: string) {
    setOutput("");
    setPin("");
    setConfirmation("");
    void action(name, () => send({ type: "logout" }));
  }

  return (
    <main>
      <h1>Scraper account</h1>
      <p>
        This experimental sign-in uses your eligible ChatGPT plan. Your sign-in
        is saved encrypted. Unlock with your four-digit PIN once per Firefox
        session. A short PIN provides limited protection against guessing.
      </p>
      <p id="status" role="status" aria-live="polite">
        {status.description}
      </p>
      <form
        id="unlock-form"
        hidden={status.configured && !status.locked}
        onSubmit={unlock}
      >
        <p id="pin-help">
          {status.configured
            ? "Enter your PIN to unlock for this Firefox session."
            : "Choose a four-digit PIN to protect your saved sign-in."}
        </p>
        <label htmlFor="pin">PIN</label>
        <input
          id="pin"
          type="password"
          inputMode="numeric"
          pattern="[0-9]{4}"
          minLength={4}
          maxLength={4}
          autoComplete="off"
          required
          value={pin}
          onChange={(event) => setPin(event.target.value)}
        />
        <label
          id="confirm-label"
          htmlFor="pin-confirm"
          hidden={status.configured}
        >
          Confirm new PIN
        </label>
        <input
          id="pin-confirm"
          type="password"
          inputMode="numeric"
          pattern="[0-9]{4}"
          maxLength={4}
          autoComplete="off"
          hidden={status.configured}
          required={!status.configured}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <button id="unlock" type="submit" disabled={running.has("unlock")}>
          {status.configured ? "Unlock" : "Set PIN"}
        </button>
      </form>
      <p>Forgotten PIN? Reset local sign-in below, then sign in again.</p>
      <button
        id="reset"
        type="button"
        disabled={running.has("reset")}
        onClick={() => reset("reset")}
      >
        Reset local sign-in
      </button>
      <label htmlFor="accounts">Account</label>
      <select
        id="accounts"
        value={account}
        onChange={(event) => setAccount(event.target.value)}
      >
        <option value="">Add a ChatGPT account</option>
        {status.registrations.map((item) => (
          <option key={item.clientId} value={item.clientId}>
            {item.label}
          </option>
        ))}
      </select>
      <div>
        <button
          id="login"
          disabled={
            !status.configured ||
            status.locked ||
            status.pending ||
            running.has("login")
          }
          onClick={() => {
            setOutput("");
            void action("login", () =>
              send({ type: "login", clientId: account || undefined }),
            );
          }}
        >
          Continue with ChatGPT
        </button>
        <button
          id="cancel"
          disabled={!status.pending || running.has("cancel")}
          onClick={() => {
            void action("cancel", () => send({ type: "cancel" }));
          }}
        >
          Cancel sign-in
        </button>
        <button
          id="logout"
          disabled={!status.configured || running.has("logout")}
          onClick={() => reset("logout")}
        >
          Sign out
        </button>
      </div>
      <h2>Check model access</h2>
      <p>
        This sends a fixed greeting to OpenAI and uses your account's allowance.
        No webpage data is sent.
      </p>
      <button
        id="models"
        disabled={!status.signedIn || running.has("models")}
        onClick={() => {
          void action("models", async () => {
            const data = await send({ type: "models" });
            const choices = (
              Array.isArray(data.models) ? data.models.filter(record) : []
            ).map((item) => ({ id: String(item.id), name: String(item.name) }));
            setModels(choices);
            setModel(choices[0]?.id ?? "");
            setOutput(
              choices.length
                ? "Model catalog loaded. A successful test request verifies access."
                : "No models were returned.",
            );
          });
        }}
      >
        Load models
      </button>
      <label htmlFor="model">Model</label>
      <select
        id="model"
        value={model}
        onChange={(event) => setModel(event.target.value)}
      >
        {models.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.name}
          </option>
        ))}
      </select>
      <button
        id="test"
        disabled={!status.signedIn || !model || running.has("test")}
        onClick={() => {
          void action("test", async () => {
            const data = await send({ type: "test", model });
            setOutput(String(data.text));
          });
        }}
      >
        Send test greeting
      </button>
      <pre id="output" aria-live="polite">
        {output}
      </pre>
      <p>
        <a
          href="https://chatgpt.com/settings/usage"
          target="_blank"
          rel="noopener noreferrer"
        >
          Manage ChatGPT usage and app access
        </a>
      </p>
    </main>
  );
}

mountPage(<Settings />);
