import type { UIAdapterModule } from "../types";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { ClaudeLocalConfigFields } from "../claude-local/config-fields";
import { buildClaudeLocalConfig } from "@paperclipai/adapter-claude-local/ui";

export const glmLocalUIAdapter: UIAdapterModule = {
  type: "glm_local",
  label: "Claude GLM (local)",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeLocalConfigFields,
  buildAdapterConfig: buildClaudeLocalConfig,
};
