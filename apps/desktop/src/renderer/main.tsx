import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { I18nProvider } from "./i18n";
import { ThemeProvider } from "./theme";
import { ChatProvider } from "./store/chat";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <ChatProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ChatProvider>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>
);
