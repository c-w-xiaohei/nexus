import type { ComponentProps } from "react";
import { CodeBlock, Pre } from "fumadocs-ui/components/codeblock";

export function CodeExample({
  html,
  ...props
}: ComponentProps<typeof CodeBlock> & { html: string }) {
  // Astro slots are HTML, not React children. Hydrate the wrapper that owns copy.
  return (
    <CodeBlock {...props}>
      <Pre dangerouslySetInnerHTML={{ __html: html }} />
    </CodeBlock>
  );
}
