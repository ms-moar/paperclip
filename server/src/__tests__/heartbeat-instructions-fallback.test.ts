import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDefaultAgentInstructionsFilePath,
  resolveDefaultCompanyAgentInstructionsPath,
} from "../services/heartbeat.ts";

const originalHome = process.env.PAPERCLIP_HOME;
const originalInstance = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalHome;
  if (originalInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = originalInstance;
});

describe("heartbeat instructions fallback", () => {
  it("injects the managed company agent AGENTS.md into local adapter config when no explicit instructions path is set", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-home-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "default";

    const agent = {
      id: "agent-1",
      companyId: "company-1",
      adapterType: "pi_local",
    };
    const instructionsPath = resolveDefaultCompanyAgentInstructionsPath({
      companyId: agent.companyId,
      agentId: agent.id,
    });
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "Пиши user-facing тексты на русском.\n", "utf8");

    await expect(applyDefaultAgentInstructionsFilePath({ agent, config: { model: "zai/glm-5" } })).resolves.toEqual({
      model: "zai/glm-5",
      instructionsFilePath: instructionsPath,
    });
  });

  it("preserves explicit instructions paths and non-local adapter configs", async () => {
    process.env.PAPERCLIP_HOME = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-home-"));
    process.env.PAPERCLIP_INSTANCE_ID = "default";

    await expect(
      applyDefaultAgentInstructionsFilePath({
        agent: { id: "agent-1", companyId: "company-1", adapterType: "pi_local" },
        config: { instructionsFilePath: "/custom/AGENTS.md" },
      }),
    ).resolves.toEqual({ instructionsFilePath: "/custom/AGENTS.md" });

    await expect(
      applyDefaultAgentInstructionsFilePath({
        agent: { id: "agent-1", companyId: "company-1", adapterType: "webhook" },
        config: { model: "noop" },
      }),
    ).resolves.toEqual({ model: "noop" });
  });
});
