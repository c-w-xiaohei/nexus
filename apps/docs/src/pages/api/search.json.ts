import type { APIRoute } from "astro";
import { createFromSource } from "fumadocs-core/search/server";
import { structure } from "fumadocs-core/mdx-plugins";
import { source } from "../../lib/source";
import { docsUrl } from "../../lib/i18n";

const search = createFromSource(source, {
  buildIndex(page) {
    return {
      id: page.url,
      title: page.data.title,
      description: page.data.description,
      structuredData: structure(page.data.entry.body ?? ""),
      url: docsUrl(page.slugs, page.locale),
    };
  },
});

export const GET: APIRoute = () => search.staticGET();
