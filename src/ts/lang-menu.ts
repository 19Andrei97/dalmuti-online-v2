/* Language switcher: a header button showing the current flag that opens a
 * dropdown of the available languages. Shared by the lobby/room bundle
 * (`main.ts`) and the sign-in bundle (`login.ts`). */

import { maybeById, qsa, show } from "./dom.js";
import { currentLang, LANGS, setLanguage, type LangCode } from "./i18n.js";

const FLAG: Record<LangCode, string> = {
  en: "/icons/flag-en.svg",
  it: "/icons/flag-it.svg",
  bg: "/icons/flag-bg.svg",
};

/** Point the button flag and the menu's active state at the current language. */
export function applyLanguageUI(active: LangCode = currentLang()): void {
  const flag = maybeById<HTMLImageElement>("lang-btn-flag");
  if (flag) flag.src = FLAG[active];
  for (const item of qsa<HTMLElement>("#lang-menu [data-lang]")) {
    item.setAttribute("aria-current", item.dataset.lang === active ? "true" : "false");
  }
}

/** Wire the button + menu (toggles the dropdown, switches language on pick). */
export function wireLanguageMenu(): void {
  const btn = maybeById<HTMLButtonElement>("lang-btn");
  const menu = maybeById("lang-menu");
  if (!btn || !menu) return;

  const close = (): void => {
    show(menu, false);
    btn.setAttribute("aria-expanded", "false");
  };
  const open = (): void => {
    show(menu, true);
    btn.setAttribute("aria-expanded", "true");
  };

  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (menu.classList.contains("hidden")) open();
    else close();
  });

  for (const item of qsa<HTMLElement>("#lang-menu [data-lang]")) {
    item.addEventListener("click", (ev) => {
      ev.preventDefault();
      const lang = item.dataset.lang as LangCode | undefined;
      if (lang && LANGS.includes(lang) && lang !== currentLang()) setLanguage(lang);
      else close();
    });
  }

  document.addEventListener("click", (ev) => {
    if (!menu.classList.contains("hidden") && !menu.contains(ev.target as Node)) close();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });

  applyLanguageUI();
}
