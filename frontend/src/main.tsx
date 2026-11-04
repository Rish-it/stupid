import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { themes, defaultThemeSlug } from "./astryx-themes";
import "./index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Theme theme={themes[defaultThemeSlug]} mode="dark">
      <App />
    </Theme>
  </StrictMode>,
);
