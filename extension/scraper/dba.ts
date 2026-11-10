import type { Spec } from "./spec";
// Checked against DBA search and an item page, 2026-11-10.
const description =
  'podium-layout >>> [data-testid="description"] .whitespace-pre-wrap';
export const dbaListings: Spec = {
  version: 1,
  name: "DBA listings with descriptions",
  identityField: "url",
  list: {
    itemSelector: "article.sf-search-ad",
    fields: {
      title: { selector: "h2", value: "text" },
      price: {
        selector: "div.font-bold > span",
        value: "text",
        optional: true,
      },
      url: {
        selector: "a.sf-search-ad-link[href]",
        value: "attribute",
        attribute: "href",
        resolveUrl: true,
      },
      images: {
        selector: "img[src]",
        value: "attribute",
        attribute: "src",
        resolveUrl: true,
        multiple: true,
        optional: true,
      },
    },
  },
  detail: {
    linkField: "url",
    waitFor: { selector: description },
    fields: { description: { selector: description, value: "text" } },
  },
};
