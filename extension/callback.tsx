import { useEffect, useState } from "react";
import { mountPage } from "./ui/root";

// Consume the fragment before rendering. Relay only once, even if React remounts.
const callbackValue = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const completion = browser.runtime
  .sendMessage({
    type: "callback",
    url: callbackValue,
  })
  .then(
    (result) =>
      result?.ok
        ? "Sign-in complete. Return to Scraper settings."
        : (result?.error ??
          "This sign-in expired. Start again from Scraper settings."),
    () => "The extension restarted. Start sign-in again from Scraper settings.",
  );

function Callback() {
  const [status, setStatus] = useState("Completing sign-in…");
  useEffect(() => {
    let live = true;
    void completion.then((message: string) => {
      if (live) setStatus(message);
    });
    return () => {
      live = false;
    };
  }, []);
  return (
    <main>
      <h1>Scraper sign-in</h1>
      <p role="status" aria-live="polite">
        {status}
      </p>
    </main>
  );
}

mountPage(<Callback />);
