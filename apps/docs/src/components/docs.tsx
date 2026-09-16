import type { ComponentProps, ReactNode } from "react";
import type { Root } from "fumadocs-core/page-tree";
import type { TOCItemType } from "fumadocs-core/toc";
import { RootProvider } from "fumadocs-ui/provider/astro";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsPage } from "fumadocs-ui/layouts/docs/page";
import Search from "./search";

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
      components={{ Link: DocsLink }}
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
