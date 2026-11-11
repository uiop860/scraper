// Tab IDs are positive; sidebar owners use a separate, window-scoped namespace.
export function scraperOwner(sender: browser.runtime.MessageSender) {
  if (
    sender.id !== browser.runtime.id ||
    sender.url?.split("?")[0] !== browser.runtime.getURL("scraper.html") ||
    (sender.frameId !== undefined && sender.frameId !== 0) ||
    sender.tab?.incognito
  )
    return undefined;
  if (sender.tab?.id !== undefined) return sender.tab.id;
  const window = new URL(sender.url).searchParams.get("window");
  if (!window || !/^\d+$/.test(window) || !Number.isSafeInteger(Number(window)))
    return undefined;
  return -Number(window) - 1;
}

export function watchSidebarDisconnect(cleanup: (owner: number) => void) {
  const connected = new Set<number>();
  browser.runtime.onConnect.addListener((port) => {
    const owner = port.sender && scraperOwner(port.sender);
    if (owner === undefined || owner >= 0 || port.name !== "scraper.sidebar")
      return;
    connected.add(owner);
    port.onDisconnect.addListener(() => {
      connected.delete(owner);
      cleanup(owner);
    });
  });
  return (owner: number) => connected.has(owner);
}
