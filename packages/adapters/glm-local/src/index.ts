export const type = "glm_local";
export const label = "Claude GLM (local)";

export const models = [
  { id: "glm-5", label: "GLM-5" },
  { id: "GLM-4.5-Air", label: "GLM-4.5 Air" },
];

export const agentConfigurationDoc = `# glm_local agent configuration

Adapter: glm_local — Claude Code CLI with Z.AI/GLM backend

Uses the same Claude CLI binary but routes requests through Z.AI API to GLM models.
All claude_local configuration fields are supported.

Core fields:
- cwd (string, optional): default absolute working directory
- model (string, optional): GLM model id (default: glm-5)
- command (string, optional): defaults to "claude"
- dangerouslySkipPermissions (boolean, optional): pass --dangerously-skip-permissions
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables (merged with GLM defaults)
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Default environment (auto-injected, can be overridden via env):
- ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
- ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5
- ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5
- ANTHROPIC_DEFAULT_HAIKU_MODEL=GLM-4.5-Air
- API_TIMEOUT_MS=3000000
`;
