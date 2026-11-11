import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

export function mountPage(page: ReactNode) {
  const root = createRoot(document.getElementById("root")!);
  root.render(page);
  function unmount() {
    window.removeEventListener("pagehide", unmount);
    root.unmount();
  }
  window.addEventListener("pagehide", unmount);
}
