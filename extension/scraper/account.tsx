import { useEffect, useState, type SubmitEvent } from "react";
import { record } from "../auth/protocol";

export function SidebarAccount() {
  const [locked, setLocked] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const status: unknown = await browser.runtime.sendMessage({
          type: "status",
        });
        if (active && record(status) && status.ok) {
          setLocked(status.configured === true && status.locked === true);
        }
      } catch {
        // A later poll retries if the background is temporarily unavailable.
      }
    }
    void refresh();
    const interval = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  async function unlock(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !/^\d{4}$/.test(pin)) return;
    const value = pin;
    setPin("");
    setPending(true);
    setError("");
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "unlock",
        pin: value,
      });
      if (!record(response) || !response.ok)
        throw new Error(
          record(response) && typeof response.error === "string"
            ? response.error
            : "Could not unlock the account.",
        );
      setLocked(false);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not unlock the account.",
      );
    } finally {
      setPending(false);
    }
  }

  if (locked === null)
    return (
      <div
        className="pin-screen"
        role="status"
        aria-label="Checking your account"
        aria-busy="true"
      />
    );
  if (!locked) return null;
  return (
    <form
      className="pin-screen"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-title"
      aria-describedby="pin-description"
      onSubmit={(event) => void unlock(event)}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const fields = Array.from(
          event.currentTarget.querySelectorAll<
            HTMLInputElement | HTMLButtonElement
          >("input:not(:disabled), button:not(:disabled)"),
        );
        const index = fields.indexOf(
          document.activeElement as HTMLInputElement | HTMLButtonElement,
        );
        event.preventDefault();
        fields[
          (index + (event.shiftKey ? -1 : 1) + fields.length) % fields.length
        ]?.focus();
      }}
    >
      <div className="pin-card">
        <div className="pin-emblem" aria-hidden="true">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="5" y="10" width="14" height="11" rx="3" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            <path d="M12 14v3" />
          </svg>
        </div>
        <span className="eyebrow">SCRAPER</span>
        <h2 id="pin-title">Welcome back</h2>
        <p id="pin-description">Enter your PIN to unlock your account.</p>
        <label className="pin-entry">
          <span className="sr-only">Four-digit PIN</span>
          <input
            id="sidebar-pin"
            type="password"
            inputMode="numeric"
            pattern="[0-9]{4}"
            minLength={4}
            maxLength={4}
            autoComplete="off"
            required
            value={pin}
            readOnly={pending}
            aria-invalid={!!error}
            aria-describedby={error ? "pin-error" : "pin-description"}
            onChange={(event) => {
              setPin(event.target.value.replace(/\D/g, "").slice(0, 4));
              setError("");
            }}
          />
          <span className="pin-boxes" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => (
              <span
                key={index}
                className="pin-box"
                data-active={index === Math.min(pin.length, 3)}
                data-filled={index < pin.length}
              >
                {index < pin.length ? "●" : ""}
              </span>
            ))}
          </span>
        </label>
        <p id="pin-error" className="pin-error" role="alert">
          {error}
        </p>
        <button
          className="pin-unlock"
          type="submit"
          disabled={pending || pin.length !== 4}
        >
          {pending ? "Unlocking…" : "Unlock account"}
        </button>
        <p className="pin-session">Stays unlocked for this Firefox session.</p>
        <button
          className="pin-settings"
          type="button"
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          Forgot your PIN?
        </button>
      </div>
    </form>
  );
}
