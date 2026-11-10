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
const running = new Set<HTMLButtonElement>();
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
async function refresh() {
  const data = await send({ type: "status" });
  const account = record(data.account) ? data.account : undefined;
  status.textContent = `${data.signedIn ? `Signed in: ${account?.email ?? account?.subject}` : "Signed out"}. ${data.notice}`;
  login.disabled = !!data.pending || running.has(login);
  cancel.disabled = !data.pending || running.has(cancel);
  logout.disabled = !data.signedIn || running.has(logout);
  load.disabled = !data.signedIn || running.has(load);
  test.disabled = !data.signedIn || !model.value || running.has(test);
  const selected = accounts.value;
  const registrations = Array.isArray(data.registrations)
    ? data.registrations.filter(record)
    : [];
  accounts.replaceChildren(
    new Option("Add a ChatGPT account", ""),
    ...registrations.map(
      (r) =>
        new Option(
          `${r.email ?? r.subject} (${String(r.clientId).slice(-8)})`,
          String(r.clientId),
        ),
    ),
  );
  accounts.value = selected;
  if (!data.signedIn) model.replaceChildren();
}
function action(button: HTMLButtonElement, run: () => Promise<unknown>) {
  button.addEventListener("click", () => {
    running.add(button);
    button.disabled = true;
    void run()
      .then(refresh)
      .catch((error) => {
        output.textContent =
          error instanceof Error ? error.message : "Request failed.";
      })
      .finally(() => {
        running.delete(button);
        void refresh().catch(() => {});
      });
  });
}
action(login, async () => {
  output.textContent = "";
  await send({ type: "login", clientId: accounts.value || undefined });
});
action(cancel, () => send({ type: "cancel" }));
action(logout, async () => {
  output.textContent = "";
  await send({ type: "logout" });
});
action(load, async () => {
  const data = await send({ type: "models" });
  const choices = Array.isArray(data.models) ? data.models.filter(record) : [];
  model.replaceChildren(
    ...choices.map((m) => new Option(String(m.name), String(m.id))),
  );
  output.textContent = choices.length
    ? "Model catalog loaded. A successful test request verifies access."
    : "No models were returned.";
});
action(test, async () => {
  const data = await send({ type: "test", model: model.value });
  output.textContent = String(data.text);
});
model.addEventListener("change", () => {
  test.disabled = !model.value;
});
void refresh().catch(() => {
  status.textContent = "Extension unavailable. Reload this page.";
});
const interval = setInterval(() => {
  void refresh().catch(() => {});
}, 2000);
window.addEventListener("pagehide", () => clearInterval(interval));
