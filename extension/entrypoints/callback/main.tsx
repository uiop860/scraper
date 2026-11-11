import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

// Capture and erase the callback before rendering or loading other resources.
const callbackValue = location.hash.slice(1);
history.replaceState(null, "", location.pathname);

function Callback() {
  const [status, setStatus] = useState("Completing sign-in…");
  useEffect(() => {
    void browser.runtime
      .sendMessage({ type: "callback", url: callbackValue })
      .then((result) => {
        setStatus(
          result?.ok
            ? "Sign-in complete. Return to Scraper settings."
            : (result?.error ??
                "This sign-in expired. Start again from Scraper settings."),
        );
      })
      .catch(() =>
        setStatus(
          "The extension restarted. Start sign-in again from Scraper settings.",
        ),
      );
  }, []);
  return (
    <>
      <h1>Scraper sign-in</h1>
      <p>{status}</p>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Callback />);
