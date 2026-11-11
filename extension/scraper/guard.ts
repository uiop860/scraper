import { navigationUrl } from "./spec";
export const workerKey = "scraperWorkers";
export interface Worker {
  owner: number;
  tab: number;
  ownsTab?: boolean;
  origin: string;
  rules: number[];
}
export function guardRules(
  tab: number,
  origin: string,
): browser.declarativeNetRequest.Rule[] {
  navigationUrl(origin, origin, origin);
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    {
      id: 1000 + tab * 2,
      priority: 1,
      action: { type: "block" },
      condition: {
        tabIds: [tab],
        resourceTypes: ["main_frame"],
        urlFilter: "*",
      },
    },
    {
      id: 1001 + tab * 2,
      priority: 2,
      action: { type: "allow" },
      condition: {
        tabIds: [tab],
        resourceTypes: ["main_frame"],
        regexFilter: `^${escaped}/`,
        isUrlFilterCaseSensitive: true,
      },
    },
  ];
}
