import { createSettingsStore } from "./state/settings";
import { record } from "./auth/protocol";
const status = document.querySelector<HTMLElement>("#status")!;
const output = document.querySelector<HTMLElement>("#output")!;
const accounts = document.querySelector<HTMLSelectElement>("#accounts")!;
const model = document.querySelector<HTMLSelectElement>("#model")!;
const login = document.querySelector<HTMLButtonElement>("#login")!;
const cancel = document.querySelector<HTMLButtonElement>("#cancel")!;
const logout = document.querySelector<HTMLButtonElement>("#logout")!;
const load = document.querySelector<HTMLButtonElement>("#models")!;
const test = document.querySelector<HTMLButtonElement>("#test")!;
const form = document.querySelector<HTMLFormElement>("#unlock-form")!;
const pin = document.querySelector<HTMLInputElement>("#pin")!;
const confirmation = document.querySelector<HTMLInputElement>("#pin-confirm")!;
const confirmLabel = document.querySelector<HTMLElement>("#confirm-label")!;
const unlock = document.querySelector<HTMLButtonElement>("#unlock")!;
const reset = document.querySelector<HTMLButtonElement>("#reset")!;
const store = createSettingsStore();
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
let refreshQueue: Promise<void> = Promise.resolve();
function refresh() {
  const result = refreshQueue.then(async () => {
    store.receiveStatus(await send({ type: "status" }));
  });
  refreshQueue = result.catch(() => {});
  return result;
}
function render() {
  const data = store.getState();
  const { configured, account, running } = data;
  status.textContent = `${data.signedIn ? `Signed in: ${account?.email ?? account?.subject}` : data.locked ? "Saved sign-in locked" : "Signed out"}. ${data.notice}`;
  output.textContent = data.output;
  form.hidden = configured && !data.locked;
  confirmation.hidden = configured;
  confirmation.required = !configured;
  confirmLabel.hidden = configured;
  unlock.textContent = configured ? "Unlock" : "Set PIN";
  unlock.disabled = running.has("unlock");
  reset.disabled = running.has("reset");
  document.querySelector<HTMLElement>("#pin-help")!.textContent = configured
    ? "Enter your PIN to unlock for this Firefox session."
    : "Choose a four-digit PIN to protect your saved sign-in.";
  login.disabled =
    !configured || data.locked || data.pending || running.has("login");
  cancel.disabled = !data.pending || running.has("cancel");
  logout.disabled = !configured || running.has("logout");
  load.disabled = !data.signedIn || running.has("models");
  test.disabled = !data.signedIn || !data.model || running.has("test");
}
const unsubscribe = store.subscribe((state, previous) => {
  if (state.registrations !== previous.registrations) {
    const selected = accounts.value;
    accounts.replaceChildren(
      new Option("Add a ChatGPT account", ""),
      ...state.registrations.map(
        (r) =>
          new Option(
            `${r.email ?? r.subject} (${r.clientId.slice(-8)})`,
            r.clientId,
          ),
      ),
    );
    accounts.value = selected;
  }
  if (state.models !== previous.models)
    model.replaceChildren(...state.models.map((m) => new Option(m.name, m.id)));
  model.value = state.model;
  render();
});
render();

function action(button: HTMLButtonElement, run: () => Promise<unknown>) {
  button.addEventListener("click", () => {
    if (!store.begin(button.id)) return;
    void run()
      .then(refresh)
      .catch((error) => {
        store.setState({
          output: error instanceof Error ? error.message : "Request failed.",
        });
      })
      .finally(() => {
        store.finish(button.id);
        void refresh().catch(() => {});
      });
  });
}
action(login, async () => {
  store.setState({ output: "" });
  await send({ type: "login", clientId: accounts.value || undefined });
});
action(cancel, () => send({ type: "cancel" }));
action(logout, async () => {
  store.setState({ output: "" });
  await send({ type: "logout" });
});
action(load, async () => {
  const data = await send({ type: "models" });
  const choices = Array.isArray(data.models) ? data.models.filter(record) : [];
  store.setState({
    models: choices.map((m) => ({ name: String(m.name), id: String(m.id) })),
    model: choices.length ? String(choices[0].id) : "",
    output: choices.length
      ? "Model catalog loaded. A successful test request verifies access."
      : "No models were returned.",
  });
});
action(test, async () => {
  const data = await send({ type: "test", model: store.getState().model });
  store.setState({ output: String(data.text) });
});
model.addEventListener("change", () => {
  store.setState({ model: model.value });
});
void refresh().catch(() => {
  store.setState({ notice: "Extension unavailable. Reload this page." });
});
const interval = setInterval(() => {
  void refresh().catch(() => {});
}, 2000);
window.addEventListener("pagehide", () => {
  clearInterval(interval);
  unsubscribe();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (unlock.disabled) return;
  if (!store.getState().configured && pin.value !== confirmation.value) {
    store.setState({ output: "PINs do not match." });
    return;
  }
  store.begin("unlock");
  const value = pin.value;
  pin.value = "";
  confirmation.value = "";
  void send({ type: "unlock", pin: value })
    .then(refresh)
    .catch((error: unknown) => {
      store.setState({
        output: error instanceof Error ? error.message : "Could not unlock.",
      });
    })
    .finally(() => {
      store.finish("unlock");
    });
});
action(reset, async () => {
  store.setState({ output: "" });
  pin.value = "";
  confirmation.value = "";
  await send({ type: "logout" });
});
