import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import enUS from "../locales/en-US.json";
import zhCN from "../locales/zh-CN.json";

export type Locale = "en-US" | "zh-CN";
type Messages = Record<string, string>;

const MESSAGES: Record<Locale, Messages> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

let _messages: Messages = MESSAGES["en-US"];

export function i18nText(key: string): string {
  return _messages[key] ?? key;
}

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
};

const I18nContext = createContext<I18nContextValue>({
  locale: "en-US",
  setLocale: () => {},
  t: (key) => key,
});

export function I18nProvider({
  children,
  defaultLocale = "en-US",
}: {
  children: ReactNode;
  defaultLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    () => (localStorage.getItem("noma:locale") as Locale) ?? defaultLocale,
  );

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem("noma:locale", next);
    _messages = MESSAGES[next];
    setLocaleState(next);
  }, []);

  _messages = MESSAGES[locale];

  const t = useCallback(
    (key: string) => MESSAGES[locale][key] ?? key,
    [locale],
  );

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}

export function useI18nText(key: string): string {
  const { t } = useContext(I18nContext);
  return t(key);
}

export function I18nText({ k }: { k: string }) {
  const text = useI18nText(k);
  return <>{text}</>;
}
