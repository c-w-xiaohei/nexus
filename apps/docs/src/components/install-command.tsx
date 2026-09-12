import {
  CodeBlock,
  CodeBlockTab,
  CodeBlockTabs,
  CodeBlockTabsList,
  CodeBlockTabsTrigger,
} from "fumadocs-ui/components/codeblock";

export function InstallCommand({
  commands,
}: {
  commands: { manager: string; html: string }[];
}) {
  return (
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
  );
}
