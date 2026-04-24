import Anthropic from "@anthropic-ai/sdk";

// Lazy-init proxy: keeps boot working when AI integration env vars are
// missing. Non-agent surfaces (dashboard, paper trading, risk, openclaw)
// keep serving; only routes that actually invoke the client see the
// configuration error, and only at request time.
let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;

  if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
    throw new Error(
      "AI_INTEGRATIONS_ANTHROPIC_BASE_URL must be set. Did you forget to provision the Anthropic AI integration?",
    );
  }

  if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
    throw new Error(
      "AI_INTEGRATIONS_ANTHROPIC_API_KEY must be set. Did you forget to provision the Anthropic AI integration?",
    );
  }

  _client = new Anthropic({
    apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
  });
  return _client;
}

// Proxy the SDK surface so existing call sites (`anthropic.messages.create(...)`)
// still work but the underlying client is only constructed on first use.
export const anthropic: Anthropic = new Proxy({} as Anthropic, {
  get(_target, prop, receiver) {
    const real = getClient();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
