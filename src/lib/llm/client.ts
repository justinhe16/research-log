import Anthropic from "@anthropic-ai/sdk";

/** Read and sanity-check the API key. Throws a message that tells the user exactly
 *  what to fix, since this surfaces verbatim in ingest / search error states. */
export function apiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add a real key to .env.local (get one at https://console.anthropic.com/settings/keys) and restart the dev server.",
    );
  }
  if (key === "sk-ant-..." || /^sk-ant-\.{3,}$/.test(key) || /^(your|placeholder|changeme)/i.test(key)) {
    throw new Error(
      "ANTHROPIC_API_KEY is still the placeholder value. Replace it in .env.local with a real key from https://console.anthropic.com/settings/keys and restart the dev server.",
    );
  }
  return key;
}

// Cached on globalThis so dev HMR reuses one client (and its connection pool).
// Keyed by the key itself so editing .env.local and restarting picks up the new one.
const globalForClient = globalThis as unknown as {
  __researchLogAnthropic?: { key: string; client: Anthropic };
};

/** Shared Anthropic client. */
export function getClient(): Anthropic {
  const key = apiKey();
  const cached = globalForClient.__researchLogAnthropic;
  if (cached && cached.key === key) return cached.client;
  const client = new Anthropic({ apiKey: key });
  globalForClient.__researchLogAnthropic = { key, client };
  return client;
}
