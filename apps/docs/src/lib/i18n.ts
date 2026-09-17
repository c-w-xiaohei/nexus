import { defineI18n } from "fumadocs-core/i18n";
import { uiTranslations } from "fumadocs-ui/i18n";
import { zhCN } from "@fumadocs/language/zh-cn";

export const i18n = defineI18n({
  languages: ["en", "zh-CN"],
  defaultLanguage: "en",
  parser: "dir",
  fallbackLanguage: null,
});

export type Locale = (typeof i18n.languages)[number];

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .preset("zh-CN", zhCN())
  .add({
    en: { displayName: "English" },
    "zh-CN": { displayName: "简体中文" },
  });

// Astro emits these paths directly: GitHub Pages has no locale middleware.
export function docsUrl(
  slugs: string[] = [],
  locale: string = i18n.defaultLanguage,
) {
  const segments = locale === "en" ? slugs : [locale, ...slugs];
  return `/nexus/docs/${segments.length ? `${segments.join("/")}/` : ""}`;
}

export function localeFromPath(pathname: string): Locale {
  return /^\/nexus\/docs\/zh-CN(?:\/|$)/.test(pathname) ? "zh-CN" : "en";
}
