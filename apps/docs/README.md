# Nexus Documentation Site

Private Astro workspace package using Fumadocs UI and Astro content collections.
The public site is deployed to <https://c-w-xiaohei.github.io/nexus/>.

## Write And Preview

From the repository root:

```bash
pnpm --filter @nexus-js/docs dev
```

The dev command rebuilds Astro's content cache on startup. After changing
Markdown processor configuration, restart it so cached pages use the new
highlighter. Fumadocs' `rehypeCode` is the only highlighter; Astro's built-in
highlighter is disabled at `markdown.syntaxHighlight` for Astro 7.

Edit `content/docs/` in this package. It is the only public documentation source;
internal `.doc/` files are not published. Use `.mdx` for pages with code examples
or components, and `.md` for plain prose. MDX fences automatically use the
Fumadocs code block with a working copy button. Every page must have `title`
and `description`:

```markdown
---
title: My Guide
description: What this guide helps the reader do.
---

## First Step

Write the guide here. The page template already renders its title.
```

Use `index.md` or `index.mdx` for a directory landing page. Add new pages to the corresponding
`meta.json` to place them in the sidebar. Use site links such as
`/nexus/docs/getting-started/`, including the Pages base and trailing slash.
Keep code examples in fenced code blocks.

The following components are registered globally in MDX, with no page import:

```mdx
<InstallCommand packages="@nexus-js/core @nexus-js/chrome" />
<InstallCommand packages="@nexus-js/testing" dev />

<Callout type="warn" title="Configure both sides">
  Configure the host and consumer before acquiring a proxy.
</Callout>

<Steps>
  <Step>
    ## Configure the host

    Describe the first step here.

  </Step>
</Steps>
```

`InstallCommand` uses Fumadocs code tabs and copy buttons, starts with pnpm,
and remembers the selected package manager. Keep repository-specific commands
such as `pnpm test` in ordinary fences instead of converting them to install tabs.
Do not put mandatory provider and consumer implementations in alternative tabs.

Code blocks and installation tabs have their own React islands because Astro's
static content slot does not hydrate nested React components automatically.
Use the provided Astro bridges rather than importing interactive React content
components directly into MDX. Static Callout, Steps, and Card components do not
need their own islands.

## Verify And Publish

```bash
pnpm --filter @nexus-js/docs build
pnpm --filter @nexus-js/docs typecheck
pnpm format:check
pnpm lint
```

The build produces `dist/` and checks local page links, resources, and anchors.
Search is a build-time JSON index queried in the browser, not a live server API.
Astro and MDX files are formatted with Prettier (plus the Astro plugin); other
supported files use the repository's Oxfmt configuration.

The existing pull-request quality workflow includes this workspace. The
`Deploy Docs` workflow publishes `dist/` with GitHub Pages Actions on pushes to
`main`, or through manual workflow dispatch. Pages must use the GitHub Actions
build source. No npm release, deployment token, or separate hosting service is
required.

## Site Structure

- `src/pages/index.astro`: brand homepage.
- `src/pages/docs/[...slug].astro`: static documentation routes.
- `src/components/docs.tsx`: Fumadocs navigation and page layout island.
- `src/lib/source.ts`: Astro collections adapted to Fumadocs' page tree.
- `src/styles/global.css`: dark yellow/green Nexus theme.
- `public/nexus-logo.png` and `public/favicon.png`: transparent display assets
  resized from the original `assets/nexus-logo.png` at the repository root.

The site self-hosts Space Grotesk for headings, navigation, and body text; code
uses the shared monospace stack. Page navigation uses normal
document loads, keeping Astro route state and the React island synchronized
without an additional client router or persistent client store.
