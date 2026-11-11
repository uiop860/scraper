import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { record } from "../../auth/protocol";
import "./style.css";

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
  const [data, setData] = useState<Record<string, unknown>>({});
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState<string[]>([]);
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [account, setAccount] = useState("");
  const [models, setModels] = useState<Record<string, unknown>[]>([]);
  const [model, setModel] = useState("");
  const configured = !!data.configured;
  const updateStatus = useCallback((next: Record<string, unknown>) => {
    setData(next);
    const registrations = Array.isArray(next.registrations)
      ? next.registrations.filter(record)
      : [];
    setAccount((selected) =>
      registrations.some((item) => item.clientId === selected) ? selected : "",
    );
    if (!next.signedIn) {
      setModels([]);
      setModel("");
    }
  }, []);
  async function refresh() {
    updateStatus(await send({ type: "status" }));
  }
  useEffect(() => {
    let active = true;
    const update = () => {
      void send({ type: "status" })
        .then((next) => {
          if (!active) return;
          updateStatus(next);
        })
        .catch(() => {
          if (active) setOutput("Extension unavailable. Reload this page.");
        });
    };
    update();
    const timer = setInterval(update, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [updateStatus]);
  async function action(name: string, run: () => Promise<unknown>) {
    if (busy.includes(name)) return;
    setBusy((previous) => [...previous, name]);
    setOutput("");
    try {
      await run();
      await refresh();
    } catch (error) {
      setOutput(error instanceof Error ? error.message : "Request failed.");
    } finally {
      setBusy((previous) => previous.filter((item) => item !== name));
    }
  }
  const registrations = Array.isArray(data.registrations)
    ? data.registrations.filter(record)
    : [];
  const identity = record(data.account) ? data.account : {};
  return (
    <main>
      <h1>Scraper account</h1>
      <p>
        This experimental sign-in uses your eligible ChatGPT plan. Your sign-in
        is saved encrypted. Unlock with your four-digit PIN once per Firefox
        session. A short PIN provides limited protection against guessing.
      </p>
      <p id="status" role="status" aria-live="polite">
        {data.ok
          ? `${data.signedIn ? `Signed in: ${identity.email ?? identity.subject}` : data.locked ? "Saved sign-in locked" : "Signed out"}. ${data.notice}`
          : "Loading…"}
      </p>
      <form
        id="unlock-form"
        hidden={configured && !data.locked}
        onSubmit={(event) => {
          event.preventDefault();
          if (!configured && pin !== confirmation) {
            setOutput("PINs do not match.");
            return;
          }
          const value = pin;
          setPin("");
          setConfirmation("");
          void action("unlock", () => send({ type: "unlock", pin: value }));
        }}
      >
        <p id="pin-help">
          {configured
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
        <label id="confirm-label" htmlFor="pin-confirm" hidden={configured}>
          Confirm new PIN
        </label>
        <input
          id="pin-confirm"
          type="password"
          inputMode="numeric"
          pattern="[0-9]{4}"
          maxLength={4}
          autoComplete="off"
          hidden={configured}
          required={!configured}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <button id="unlock" disabled={busy.includes("unlock")}>
          {configured ? "Unlock" : "Set PIN"}
        </button>
      </form>
      <p>Forgotten PIN? Reset local sign-in below, then sign in again.</p>
      <button
        id="reset"
        disabled={busy.includes("reset")}
        onClick={() => {
          setPin("");
          setConfirmation("");
          void action("reset", () => send({ type: "logout" }));
        }}
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
        {registrations.map((item) => (
          <option key={String(item.clientId)} value={String(item.clientId)}>
            {String(item.email ?? item.subject)} (
            {String(item.clientId).slice(-8)})
          </option>
        ))}
      </select>
      <div>
        <button
          id="login"
          disabled={
            !configured ||
            !!data.locked ||
            !!data.pending ||
            busy.includes("login")
          }
          onClick={() =>
            void action("login", () =>
              send({ type: "login", clientId: account || undefined }),
            )
          }
        >
          Continue with ChatGPT
        </button>
        <button
          id="cancel"
          disabled={!data.pending || busy.includes("cancel")}
          onClick={() => void action("cancel", () => send({ type: "cancel" }))}
        >
          Cancel sign-in
        </button>
        <button
          id="logout"
          disabled={!configured || busy.includes("logout")}
          onClick={() => void action("logout", () => send({ type: "logout" }))}
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
        disabled={!data.signedIn || busy.includes("models")}
        onClick={() =>
          void action("models", async () => {
            const result = await send({ type: "models" });
            const choices = Array.isArray(result.models)
              ? result.models.filter(record)
              : [];
            setModels(choices);
            setModel(choices.length ? String(choices[0]!.id) : "");
            setOutput(
              choices.length
                ? "Model catalog loaded. A successful test request verifies access."
                : "No models were returned.",
            );
          })
        }
      >
        Load models
      </button>
      <label htmlFor="model">Model</label>
      <select
        id="model"
        value={model}
        onChange={(event) => setModel(event.target.value)}
      >
        {models.map((item) => (
          <option key={String(item.id)} value={String(item.id)}>
            {String(item.name)}
          </option>
        ))}
      </select>
      <button
        id="test"
        disabled={!data.signedIn || !model || busy.includes("test")}
        onClick={() =>
          void action("test", async () => {
            const result = await send({ type: "test", model });
            setOutput(String(result.text));
          })
        }
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

createRoot(document.getElementById("root")!).render(<Settings />);
