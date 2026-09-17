import {
  CodeBlock,
  CodeBlockTab,
  CodeBlockTabs,
  CodeBlockTabsList,
  CodeBlockTabsTrigger,
} from "fumadocs-ui/components/codeblock";
import { RootProvider } from "fumadocs-ui/provider/astro";
import { i18nProvider } from "fumadocs-ui/i18n";
import { translations, type Locale } from "../lib/i18n";

export function InstallCommand({
  commands,
  locale,
}: {
  commands: { manager: string; html: string }[];
  locale: Locale;
}) {
  return (
    <RootProvider
      pathname=""
      params={{}}
      theme={{ enabled: false }}
      search={{ enabled: false }}
      i18n={i18nProvider(translations, locale)}
    >
      <CodeBlockTabs defaultValue="pnpm" groupId="package-manager" persist>
        <CodeBlockTabsList>
          {commands.map(({ manager }) => (
            <CodeBlockTabsTrigger key={manager} value={manager}>
              {manager}
            </CodeBlockTabsTrigger>
          ))}
        </CodeBlockTabsList>
        {commands.map(({ manager, html }) => (
          <CodeBlockTab key={manager} value={manager}>
            <CodeBlock>
              <div dangerouslySetInnerHTML={{ __html: html }} />
            </CodeBlock>
          </CodeBlockTab>
        ))}
      </CodeBlockTabs>
    </RootProvider>
  );
}
