import { scraperOwner, watchSidebarDisconnect } from "./owner";
import type OpenAI from "openai";
import type { Authentication } from "../auth/lifecycle";
import { AuthError, record } from "../auth/protocol";
import { models, responseTurn } from "../auth/client";
import { AGENT_LIMITS, agentInstructions, agentTools } from "./agent";

// Credentials and the SDK remain in the background. Web pages cannot invoke AI.
export function registerScraperAgent(auth: Authentication) {
  const catalogs = new Map<number, string[]>();
  const pending = new Map<number, AbortController>();
  const cancel = (owner: number) => {
    pending.get(owner)?.abort();
    pending.delete(owner);
  };
  watchSidebarDisconnect((owner) => {
    cancel(owner);
    catalogs.delete(owner);
  });
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    const owner = scraperOwner(sender);
    if (
      owner === undefined ||
      !record(message) ||
      typeof message.type !== "string" ||
      !message.type.startsWith("scraper.agent.")
    )
      return;
    if (message.type === "scraper.agent.cancel") {
      cancel(owner);
      return Promise.resolve({ ok: true });
    }
    return (async () => {
      if (
        !["scraper.agent.models", "scraper.agent.turn"].includes(
          message.type as string,
        )
      )
        throw new AuthError("Invalid agent request.");
      const allowed =
        message.type === "scraper.agent.models"
          ? ["type"]
          : ["type", "model", "input"];
      if (Object.keys(message).some((key) => !allowed.includes(key)))
        throw new AuthError("Invalid agent request.");
      if (pending.has(owner))
        throw new AuthError("An agent request is already running.");
      if (
        message.type === "scraper.agent.turn" &&
        (typeof message.model !== "string" ||
          !catalogs.get(owner)?.includes(message.model) ||
          !Array.isArray(message.input) ||
          new TextEncoder().encode(JSON.stringify(message.input)).length >
            AGENT_LIMITS.transcriptBytes)
      )
        throw new AuthError(
          "Load a model and provide a bounded agent conversation first.",
        );
      const controller = new AbortController();
      pending.set(owner, controller);
      const signal = AbortSignal.any([controller.signal, auth.signal]);
      try {
        if (
          message.type === "scraper.agent.turn" &&
          !(await browser.permissions.contains({
            data_collection: ["websiteContent", "browsingActivity"],
          }))
        )
          throw new AuthError(
            "Allow website content sharing with OpenAI before generating a scraper.",
          );
        let tokens = await auth.credentials();
        signal.throwIfAborted();
        if (message.type === "scraper.agent.models") {
          let choices;
          try {
            choices = await models(tokens, signal);
          } catch (error) {
            if (!(error instanceof AuthError) || error.status !== 401)
              throw error;
            auth.invalidateAccess(tokens);
            tokens = await auth.credentials();
            choices = await models(tokens, signal);
          }
          signal.throwIfAborted();
          catalogs.set(
            owner,
            choices.map((m) => m.id),
          );
          return { ok: true, models: choices };
        }
        const response = await responseTurn(
          tokens,
          {
            model: message.model as string,
            input: message.input as OpenAI.Responses.ResponseInput,
            instructions: agentInstructions,
            tools: agentTools,
            parallel_tool_calls: false,
            include: ["reasoning.encrypted_content"],
            max_output_tokens: 12_000,
          },
          signal,
        ).catch((error: unknown) => {
          if (error instanceof AuthError && error.status === 401)
            auth.invalidateAccess(tokens);
          throw error;
        });
        signal.throwIfAborted();
        return { ok: true, ...response };
      } finally {
        if (pending.get(owner) === controller) pending.delete(owner);
      }
    })().catch((error: unknown) => ({
      ok: false,
      error:
        error instanceof AuthError
          ? error.message
          : "Agent request cancelled or unavailable. Check account settings.",
    }));
  });
  browser.tabs.onRemoved.addListener((owner) => {
    cancel(owner);
    catalogs.delete(owner);
  });
  browser.tabs.onUpdated.addListener((owner, change) => {
    if (
      change.url &&
      change.url.split("?")[0] !== browser.runtime.getURL("scraper.html")
    ) {
      cancel(owner);
      catalogs.delete(owner);
    }
  });
}
