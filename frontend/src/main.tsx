import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { themes, defaultThemeSlug } from "./astryx-themes";
import "./index.css";
import App from "./App.tsx";

// After a deploy, an open tab asks for chunks that are gone. Reload once to get the new ones; a second failure in a row shows the error.
addEventListener("vite:preloadError", event => {
  try {
    if (sessionStorage.getItem("stupid.reloaded")) return;
    sessionStorage.setItem("stupid.reloaded", "1");
  } catch { return; }
  event.preventDefault();
  location.reload();
});
addEventListener("load", () => setTimeout(() => { try { sessionStorage.removeItem("stupid.reloaded"); } catch { /* private mode */ } }, 10_000));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Theme theme={themes[defaultThemeSlug]} mode="dark">
      <App />
    </Theme>
  </StrictMode>,
);
