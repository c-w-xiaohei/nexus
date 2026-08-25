export namespace Cleanup {
  export const isGeneratedPath = (path: string): boolean =>
    path === "extension/.output" ||
    path.startsWith("extension/.output/") ||
    path === "extension/.wxt" ||
    path.startsWith("extension/.wxt/");

  export const ignoreEntries = (): readonly string[] => [
    "extension/.output/",
    "extension/.wxt/",
  ];
}
