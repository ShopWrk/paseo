import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { canRunRealProvider, createRealProviderClients } from "./real-provider-test-config.js";
import { startHubActionSink, type HubActionSink } from "../hub/test-utils/hub-action-sink.js";

const META_MODEL = "vercel-ai-gateway/meta/muse-spark-1.3-contributor";

describe("daemon E2E (real Pi) - Hub tool policy", () => {
  const logger = pino({ level: "silent" });
  let canRun = false;
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  let sink: HubActionSink | undefined;
  let cwd: string | undefined;

  beforeAll(async () => {
    canRun = await canRunRealProvider("pi");
    if (!canRun) return;

    cwd = mkdtempSync(path.join(tmpdir(), "paseo-pi-hub-policy-"));
    sink = await startHubActionSink();
    daemon = await createTestPaseoDaemon({
      agentClients: createRealProviderClients(["pi"], logger),
      logger,
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "pi-hub-tool-policy" } });
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close();
    await sink?.close();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  test("calls exact preapproved Hub tools without interactive approval", async (context) => {
    if (!canRun || !client || !sink || !cwd) {
      context.skip();
      return;
    }

    const agent = await client.createAgent({
      provider: "pi",
      model: META_MODEL,
      thinkingOptionId: "max",
      cwd,
      mcpServers: { hub: { type: "http", url: sink.url } },
      toolPolicy: {
        preapproved: [
          { kind: "mcp", server: "hub", tool: "reply" },
          { kind: "mcp", server: "hub", tool: "finish_execution" },
        ],
      },
      initialPrompt: [
        "Use the Hub MCP server to call reply exactly once with actionId policy-e2e and message READY.",
        "Then call finish_execution exactly once with classification safe, confidence 1, and summary READY.",
        "Do not call undeclared_action. End the turn after both calls.",
      ].join(" "),
    });

    await client.waitForFinish(agent.id, 180_000);
    const timeline = await client.fetchAgentTimeline(agent.id, { limit: 100 });
    expect(sink.calls.map((call) => call.name)).toEqual(["reply", "finish_execution"]);
    expect(sink.calls[0]?.input).toMatchObject({ actionId: "policy-e2e", message: "READY" });
    expect(timeline.agent?.pendingPermissions).toEqual([]);
  }, 240_000);
});
