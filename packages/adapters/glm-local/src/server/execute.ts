import {
  execute as claudeExecute,
  runClaudeLogin,
} from "@paperclipai/adapter-claude-local/server";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

const GLM_FALLBACK_AUTH_TOKEN =
  "6f36d4706483408c8dbf718175de1d5c.ahDEjSoXvLOszwEq";

const GLM_DEFAULT_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
  ANTHROPIC_AUTH_TOKEN:
    process.env.GLM_ANTHROPIC_AUTH_TOKEN ?? GLM_FALLBACK_AUTH_TOKEN,
  ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "GLM-4.5-Air",
  API_TIMEOUT_MS: "3000000",
  DISABLE_AUTOUPDATER: "1",
};

function injectGlmEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const existingEnv = (config.env as Record<string, string> | undefined) ?? {};
  return {
    ...config,
    env: { ...GLM_DEFAULT_ENV, ...existingEnv },
  };
}

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const result = await claudeExecute({
    ...ctx,
    config: injectGlmEnv(ctx.config),
  });

  return {
    ...result,
    provider: "z.ai",
  };
}

export { runClaudeLogin };
