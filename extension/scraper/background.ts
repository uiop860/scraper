import { guardRules, workerKey, type Worker } from "./guard";
import { navigationUrl } from "./spec";

export function registerScraperBackground() {
  // Serializing lifecycle mutations also prevents open/close races on UI shutdown.
  let queue = Promise.resolve();
  async function workers(): Promise<Worker[]> {
    return (
      ((await browser.storage.session.get(workerKey))[workerKey] as
        Worker[] | undefined) ?? []
    );
  }
  async function remove(worker: Worker) {
    // Close before removing the guard, including when the UI disappears mid-navigation.
    try {
      await browser.tabs.remove(worker.tab);
    } catch {
      // Only release rules once the tab is known to be gone.
      const exists = await browser.tabs.get(worker.tab).then(
        () => true,
        () => false,
      );
      if (exists)
        throw new Error(
          "Worker tab could not be closed; its navigation guard remains installed.",
        );
    }
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: worker.rules,
    });
    await browser.storage.session.set({
      [workerKey]: (await workers()).filter((w) => w.tab !== worker.tab),
    });
  }
  function enqueue(work: () => Promise<unknown>): Promise<unknown> {
    const result = queue.then(work);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (
      sender.id !== browser.runtime.id ||
      sender.url?.split("?")[0] !== browser.runtime.getURL("scraper.html") ||
      sender.frameId !== 0 ||
      sender.tab?.id === undefined ||
      sender.tab.incognito
    )
      return;
    if (
      !message ||
      typeof message !== "object" ||
      !("type" in message) ||
      typeof message.type !== "string" ||
      !message.type.startsWith("scraper.worker.")
    )
      return;
    const owner = sender.tab.id;
    const task = message as Record<string, unknown>;
    return enqueue(async () => {
      if (task.type === "scraper.worker.close") {
        for (const worker of await workers())
          if (worker.owner === owner) await remove(worker);
        return { ok: true };
      }
      if (
        task.type !== "scraper.worker.open" ||
        typeof task.sourceTab !== "number"
      )
        throw new Error("Invalid worker request.");
      const source = await browser.tabs.get(task.sourceTab);
      if (!source.url || source.incognito)
        throw new Error("Source tab unavailable.");
      const origin = new URL(source.url).origin;
      navigationUrl(source.url, source.url, origin);
      if (
        ["auth.openai.com", "api.openai.com"].includes(new URL(origin).hostname)
      )
        throw new Error("Authentication origins cannot be scraped.");
      if (!(await browser.permissions.contains({ origins: [`${origin}/*`] })))
        throw new Error("Site access has not been granted.");
      for (const worker of await workers())
        if (worker.owner === owner) await remove(worker);
      const tab = await browser.tabs.create({
        url: "about:blank",
        active: false,
      });
      if (tab.id === undefined) throw new Error("Could not create worker tab.");
      const rules = guardRules(tab.id, origin);
      const worker: Worker = {
        owner,
        tab: tab.id,
        origin,
        rules: rules.map((r) => r.id),
      };
      try {
        await browser.storage.session.set({
          [workerKey]: [...(await workers()), worker],
        });
        await browser.declarativeNetRequest.updateSessionRules({
          addRules: rules,
        });
        // Owner may have closed while we installed the guard.
        const ui = await browser.tabs.get(owner);
        if (ui.url?.split("?")[0] !== browser.runtime.getURL("scraper.html"))
          throw new Error("Scraper UI closed.");
        return { ok: true, tab: worker.tab, origin, startUrl: source.url };
      } catch (error) {
        await remove(worker);
        throw error;
      }
    }).catch((error: unknown) => ({
      ok: false,
      error:
        error instanceof Error ? error.message : "Worker operation failed.",
    }));
  });
  browser.tabs.onRemoved.addListener((tab) => {
    void enqueue(async () => {
      for (const worker of await workers())
        if (worker.owner === tab || worker.tab === tab) await remove(worker);
    });
  });
  browser.tabs.onUpdated.addListener((tab, change) => {
    if (!change.url) return;
    void enqueue(async () => {
      for (const worker of await workers()) {
        if (
          worker.owner === tab &&
          change.url?.split("?")[0] !== browser.runtime.getURL("scraper.html")
        )
          await remove(worker);
        if (worker.tab === tab) {
          try {
            navigationUrl(change.url!, change.url!, worker.origin);
          } catch {
            if (change.url !== "about:blank") await remove(worker);
          }
        }
      }
    });
  });
}
