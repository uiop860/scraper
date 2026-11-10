// This narrowly web-accessible page only relays to our own background context.
const callbackValue = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const statusElement = document.querySelector("p")!;
void browser.runtime
  .sendMessage({ type: "callback", url: callbackValue })
  .then((result) => {
    statusElement.textContent = result?.ok
      ? "Sign-in complete. Return to Scraper settings."
      : (result?.error ??
        "This sign-in expired. Start again from Scraper settings.");
  })
  .catch(() => {
    statusElement.textContent =
      "The extension restarted. Start sign-in again from Scraper settings.";
  });
