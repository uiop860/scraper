import type { Spec } from "./spec";
// Checked against DBA's search DOM, 2026-11-10. Light-DOM listings only.
export const dbaListings: Spec = {
  version: 1,
  name: "DBA listings (current page)",
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
};
