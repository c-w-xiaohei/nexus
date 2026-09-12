import type { ReactNode } from "react";
import type { Root } from "fumadocs-core/page-tree";
import type { TOCItemType } from "fumadocs-core/toc";
import { RootProvider } from "fumadocs-ui/provider/astro";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsPage } from "fumadocs-ui/layouts/docs/page";
import Search from "./search";

export function Docs({
  tree,
  pathname,
  slugs,
  toc,
  children,
}: {
  tree: Root;
  pathname: string;
  slugs: string[];
  toc: TOCItemType[];
  children: ReactNode;
}) {
  return (
    <RootProvider
      pathname={pathname}
      params={{ slug: slugs }}
      theme={{ enabled: false }}
      search={{ SearchDialog: Search }}
    >
      <DocsLayout
        tree={tree}
        themeSwitch={{ enabled: false }}
        nav={{
          url: "/nexus/",
          title: (
            <span className="brand">
              <img src="/nexus/nexus-logo.png" width={30} height={30} alt="" />
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
