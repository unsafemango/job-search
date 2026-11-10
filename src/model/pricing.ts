/** Estimated cost of a request, from its token counts. Anthropic API list prices, US dollars per million tokens. */
import type { Usage } from "./rating.js";

type Price = { input: number; output: number; cacheRead: number };

export const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/** The most expensive known price, used for a model not in the table so the spend cap errs on the safe side. */
const HIGHEST: Price = { input: 10, output: 50, cacheRead: 1 };

export function costUsd(usage: Usage, model: string): number {
  const p = PRICES[model] ?? HIGHEST;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.input * 1.25) /
    1_000_000
  );
}
