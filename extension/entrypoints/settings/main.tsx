import { createPreferencesStore } from "../../state/preferences";
import "./style.css";
import { useStore } from "zustand";
import { createSettingsStore } from "../../state/settings";
import { storeField } from "../../state/field";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SubmitEvent,
} from "react";
import { mountPage } from "../../ui/root";
import { record } from "../../auth/protocol";

type AccountStatus = {
  configured: boolean;
  locked: boolean;
  signedIn: boolean;
  pending: boolean;
  description: string;
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
  const [preferences] = useState(createPreferencesStore);
  const model = useStore(preferences, (state) => state.model);
  const [store] = useState(createSettingsStore);
  const state = useStore(store);
  const { output, models, running } = state;
  const status: AccountStatus = {
    ...state,
    description:
      state.notice === "Loading…"
        ? "Loading…"
        : `${state.signedIn ? `Signed in: ${state.account?.email ?? state.account?.subject}` : state.locked ? "Saved sign-in locked" : "Signed out"}. ${state.notice}`,
  };
  const setOutput = storeField(store, "output");
  const setModels = storeField(store, "models");
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const live = useRef(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const data = await send({ type: "status" });
    if (!live.current || request !== sequence.current) return;
    store.receiveStatus(data);
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
  function unlock(event: SubmitEvent<HTMLFormElement>) {
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
      <header className="page-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>{" "}
          Scraper
        </div>
        <p className="eyebrow">YOUR WORKSPACE</p>
        <h1>Settings</h1>
        <p className="intro">
          Make yourself at home. Manage your account, protect your sign-in, and
          choose your model.
        </p>
      </header>
      <div className="settings-grid">
        <section
          className="settings-card account-card"
          aria-labelledby="account-heading"
        >
          <div className="section-heading">
            <span className="section-number" aria-hidden="true">
              01
            </span>
            <div>
              <h2 id="account-heading">ChatGPT account</h2>
              <p>Connect your eligible ChatGPT plan.</p>
            </div>
          </div>
          <div className="account-status" data-connected={status.signedIn}>
            <span className="status-dot" aria-hidden="true" />
            <p id="status" role="status" aria-live="polite">
              {status.description}
            </p>
          </div>
          <div className="button-row">
            <button
              id="login"
              disabled={
                !status.configured ||
                status.locked ||
                status.pending ||
                status.signedIn ||
                running.has("login")
              }
              onClick={() => {
                setOutput("");
                void action("login", () =>
                  send({ type: "login", clientId: state.account?.clientId }),
                );
              }}
            >
              {running.has("login")
                ? "Opening sign-in…"
                : "Continue with ChatGPT"}
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
          <p className="hint">
            Connect one ChatGPT account at a time. To use a different account,
            sign out first. This experimental connection uses your ChatGPT plan.
          </p>
        </section>
        <section
          className="settings-card security-card"
          aria-labelledby="security-heading"
        >
          <div className="section-heading">
            <span className="section-number" aria-hidden="true">
              02
            </span>
            <div>
              <h2 id="security-heading">Sign-in security</h2>
              <p>A little protection for your saved account.</p>
            </div>
          </div>
          <p className="hint">
            Your sign-in is saved encrypted. Unlock it with your four-digit PIN
            once per Firefox session. A short PIN provides limited protection
            against guessing.
          </p>
          <form
            id="unlock-form"
            hidden={status.configured && !status.locked}
            onSubmit={unlock}
          >
            <p id="pin-help" className="hint">
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
              aria-describedby="pin-help"
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
          <div className="reset-area">
            <p className="hint">
              Forgot your PIN? Reset your local sign-in, then connect your
              account again.
            </p>
            <button
              id="reset"
              type="button"
              disabled={running.has("reset")}
              onClick={() => reset("reset")}
            >
              Reset local sign-in
            </button>
          </div>
        </section>
        <section
          className="settings-card model-card"
          aria-labelledby="model-heading"
        >
          <div className="section-heading">
            <span className="section-number" aria-hidden="true">
              03
            </span>
            <div>
              <h2 id="model-heading">Model preferences</h2>
              <p>Choose the model that powers your scraper.</p>
            </div>
          </div>
          <p>
            Your selected model is saved and used by the sidebar across
            sessions.
          </p>
          <button
            id="models"
            disabled={!status.signedIn || running.has("models")}
            onClick={() => {
              void action("models", async () => {
                const data = await send({ type: "models" });
                const choices = (
                  Array.isArray(data.models) ? data.models.filter(record) : []
                ).map((item) => ({
                  id: String(item.id),
                  name: String(item.name),
                }));
                setModels(choices);
                const selected = preferences.getState().model;
                if (!selected && choices[0]) {
                  await preferences.getState().setModel(choices[0].id);
                }
                setOutput(
                  choices.length
                    ? "Model catalog loaded. A successful test request verifies access."
                    : "No models were returned.",
                );
              });
            }}
          >
            {running.has("models") ? "Loading models…" : "Load models"}
          </button>
          <label htmlFor="model">Model</label>
          <select
            id="model"
            value={model}
            onChange={(event) => {
              const selectedModel = event.target.value;
              void action("save-model", async () => {
                await preferences.getState().setModel(selectedModel);
              });
            }}
            disabled={running.has("save-model")}
          >
            {!models.some((choice) => choice.id === model) && (
              <option value={model}>{model || "Load models to choose"}</option>
            )}
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
            {running.has("test") ? "Sending greeting…" : "Send test greeting"}
          </button>
          <p className="hint">
            The test sends a fixed greeting to OpenAI and uses your account’s
            allowance. No webpage data is sent.
          </p>
        </section>
      </div>
      <section
        className="feedback"
        hidden={!output}
        aria-label="Request result"
      >
        <p className="eyebrow">REQUEST RESULT</p>
        <pre id="output" aria-live="polite">
          {output}
        </pre>
      </section>
      <footer>
        <p>
          <a
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noopener noreferrer"
          >
            Manage ChatGPT usage and app access
          </a>
        </p>
        <span>Scraper · Settings saved automatically</span>
      </footer>
    </main>
  );
}

mountPage(<Settings />);
