import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("reads the model table from stdout even when pi writes warnings to stderr", async () => {
    // Not os.tmpdir(): /tmp is mounted noexec on some hosts, which makes the
    // stub unspawnable (EACCES). node_modules/.tmp is always gitignored.
    const dir = path.join(
      fileURLToPath(new URL("../../node_modules/.tmp/", import.meta.url)),
      `pi-models-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await fs.mkdir(dir, { recursive: true });
    const commandPath = path.join(dir, "pi-stub");
    await fs.writeFile(
      commandPath,
      `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.error('Warning: No models match pattern "zai-new/glm-5.2"');
  console.log("provider  model            context  max-out  thinking  images");
  console.log("openai    gpt-5.6-terra    272K     128K     yes       yes");
  process.exit(0);
}
process.exit(1);
`,
      "utf8",
    );
    await fs.chmod(commandPath, 0o755);
    process.env.PAPERCLIP_PI_COMMAND = commandPath;

    await expect(listPiModels()).resolves.toEqual([
      { id: "openai/gpt-5.6-terra", label: "openai/gpt-5.6-terra" },
    ]);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });
});
