import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: "**/*.{md,mdx}", base: "./content/docs" }),
    schema: z.object({ title: z.string(), description: z.string() }),
  }),
  meta: defineCollection({
    loader: glob({ pattern: "**/meta.json", base: "./content/docs" }),
    schema: z.object({
      title: z.string().optional(),
      pages: z.array(z.string()).optional(),
      defaultOpen: z.boolean().optional(),
    }),
  }),
};
