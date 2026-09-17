import type { ComponentProps } from "react";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";
import { RootProvider } from "fumadocs-ui/provider/astro";
import { i18nProvider } from "fumadocs-ui/i18n";
import { translations, type Locale } from "../lib/i18n";

export function CodeExample({
  html,
  locale,
  ...props
}: ComponentProps<typeof CodeBlock> & { html: string; locale: Locale }) {
  // Astro slots are HTML, not React children. Hydrate the wrapper that owns copy.
  return (
    <RootProvider
      pathname=""
      params={{}}
      theme={{ enabled: false }}
      search={{ enabled: false }}
      i18n={i18nProvider(translations, locale)}
    >
      <CodeBlock {...props}>
        <Pre dangerouslySetInnerHTML={{ __html: html }} />
      </CodeBlock>
    </RootProvider>
  );
}
