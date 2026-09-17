import type { ComponentProps, ReactNode } from "react";
import type { Root } from "fumadocs-core/page-tree";
import type { TOCItemType } from "fumadocs-core/toc";
import { RootProvider } from "fumadocs-ui/provider/astro";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsPage } from "fumadocs-ui/layouts/docs/page";
import Search from "./search";
import { i18nProvider } from "fumadocs-ui/i18n";
import { translations, type Locale } from "../lib/i18n";

// Keep Fumadocs' normalized tree URLs for active-path matching. Add the Pages
// trailing slash only when rendering a link, not when building the page tree.
function DocsLink({
  href,
  prefetch: _prefetch,
  ...props
}: ComponentProps<"a"> & { prefetch?: boolean }) {
  const url = href?.replace(
    /^(\/nexus(?:\/[^?#]*)?)([?#].*)?$/,
    (_, path, suffix = "") =>
      `${path.endsWith("/") ? path : `${path}/`}${suffix}`,
  );
  return <a {...props} href={url} />;
}

export function Docs({
  tree,
  pathname,
  slugs,
  toc,
  children,
  locale,
  languageUrls,
}: {
  tree: Root;
  pathname: string;
  slugs: string[];
  toc: TOCItemType[];
  children: ReactNode;
  locale: Locale;
  languageUrls: Partial<Record<Locale, string>>;
}) {
  const languageProvider = i18nProvider(translations, locale);
  return (
    <RootProvider
      pathname={pathname}
      params={{ slug: slugs, lang: locale }}
      theme={{ defaultTheme: "system", enableSystem: true }}
      i18n={{
        ...languageProvider,
        locales: languageProvider.locales?.filter(
          (item) => languageUrls[item.locale as Locale],
        ),
        onLocaleChange(value) {
          const url = languageUrls[value as Locale];
          if (url)
            window.location.assign(
              `${url}${window.location.search}${window.location.hash}`,
            );
        },
      }}
      search={{ SearchDialog: Search }}
      components={{ Link: DocsLink }}
    >
      <DocsLayout
        tree={tree}
        themeSwitch={{ enabled: true, mode: "light-dark-system" }}
        nav={{
          url: "/nexus/",
          title: (
            <span className="brand">
              <img src="/nexus/nexus-logo.png" height={24} alt="" />
              <span>nexus</span>
            </span>
          ),
        }}
        githubUrl="https://github.com/c-w-xiaohei/nexus"
      >
        <DocsPage toc={toc}>{children}</DocsPage>
      </DocsLayout>
    </RootProvider>
  );
}
