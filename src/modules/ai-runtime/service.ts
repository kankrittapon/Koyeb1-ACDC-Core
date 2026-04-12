import {
  createOpenClawGatewayClient,
  resolveOpenClawGatewayConfig
} from "extension-koyeb";
import crypto from "node:crypto";
import { config } from "../../config";

type OpenClawProbeStatus = {
  configured: boolean;
  reachable: boolean;
  url: string | null;
  detail: string;
  health?: unknown;
  status?: unknown;
  models?: unknown;
};

type OpenClawChatHistoryRecord = {
  messages?: unknown[];
};

type OpenClawChatRequestInput = {
  sessionKey: string;
  prompt: string;
  context?: string;
  timeoutMs?: number;
  historyLimit?: number;
};

function createGatewayConfig() {
  return resolveOpenClawGatewayConfig({
    OPENCLAW_GATEWAY_URL: config.OPENCLAW_GATEWAY_URL,
    OPENCLAW_GATEWAY_TOKEN: config.OPENCLAW_GATEWAY_TOKEN,
    OPENCLAW_CLIENT_DISPLAY_NAME: "Koyeb1 ACDC Core",
    OPENCLAW_CLIENT_VERSION: "0.1.0",
    OPENCLAW_CLIENT_PLATFORM: "node",
    OPENCLAW_DEVICE_FAMILY: "server",
    OPENCLAW_GATEWAY_SCOPES: "operator.read,operator.write"
  });
}

function buildOpenClawUserMessage(input: Pick<OpenClawChatRequestInput, "prompt" | "context">) {
  return input.context ? `${input.context}\n\nUser request: ${input.prompt}` : input.prompt;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessageTextBlock(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    if (typeof record.text === "string" && record.text.trim()) {
      parts.push(record.text.trim());
      continue;
    }

    if (typeof record.content === "string" && record.content.trim()) {
      parts.push(record.content.trim());
      continue;
    }
  }

  return parts.join("\n\n").trim();
}

function extractAssistantMessages(messages: unknown[]): string[] {
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") {
        return null;
      }

      const record = message as Record<string, unknown>;
      if (record.role !== "assistant") {
        return null;
      }

      const text = extractMessageTextBlock(record.content);
      return text || null;
    })
    .filter((value): value is string => Boolean(value));
}

function buildAssistantSnapshot(history: unknown): { count: number; latest: string | null } {
  const record = history as OpenClawChatHistoryRecord | null;
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const assistantMessages = extractAssistantMessages(messages);

  return {
    count: assistantMessages.length,
    latest: assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null
  };
}

export async function requestOpenClawChatReply(input: OpenClawChatRequestInput): Promise<string> {
  if (!config.OPENCLAW_GATEWAY_URL || !config.OPENCLAW_GATEWAY_TOKEN) {
    throw new Error("OpenClaw gateway env is not configured in Koyeb1");
  }

  const gatewayConfig = createGatewayConfig();
  const client = createOpenClawGatewayClient(gatewayConfig);
  const historyLimit = input.historyLimit ?? 200;
  const timeoutMs = input.timeoutMs ?? 60000;
  const startedAt = Date.now();
  const runId = `line_ai_${Date.now()}_${crypto.randomUUID()}`;

  try {
    await client.connect();

    const beforeHistory = await client.request<OpenClawChatHistoryRecord>("chat.history", {
      sessionKey: input.sessionKey,
      limit: historyLimit,
      maxChars: 500000
    });
    const beforeSnapshot = buildAssistantSnapshot(beforeHistory);

    await client.sendChat({
      sessionKey: input.sessionKey,
      message: buildOpenClawUserMessage(input),
      deliver: false,
      timeoutMs,
      idempotencyKey: runId
    });

    while (Date.now() - startedAt < timeoutMs) {
      await sleep(1200);

      const history = await client.request<OpenClawChatHistoryRecord>("chat.history", {
        sessionKey: input.sessionKey,
        limit: historyLimit,
        maxChars: 500000
      });
      const snapshot = buildAssistantSnapshot(history);

      if (!snapshot.latest) {
        continue;
      }

      if (snapshot.count > beforeSnapshot.count || snapshot.latest !== beforeSnapshot.latest) {
        return snapshot.latest;
      }
    }

    throw new Error("Timed out waiting for OpenClaw assistant reply");
  } finally {
    client.close();
  }
}

export async function probeOpenClawRuntime(): Promise<OpenClawProbeStatus> {
  if (!config.OPENCLAW_GATEWAY_URL || !config.OPENCLAW_GATEWAY_TOKEN) {
    return {
      configured: false,
      reachable: false,
      url: config.OPENCLAW_GATEWAY_URL ?? null,
      detail: "OpenClaw gateway env is not configured in Koyeb1"
    };
  }

  const gatewayConfig = createGatewayConfig();

  const client = createOpenClawGatewayClient(gatewayConfig);

  try {
    await client.connect();
    const [health, status, models] = await Promise.all([
      client.health(),
      client.status(),
      client.listModels()
    ]);

    return {
      configured: true,
      reachable: true,
      url: gatewayConfig.url,
      detail: "OpenClaw gateway is reachable from Koyeb1",
      health,
      status,
      models
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      url: gatewayConfig.url,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    client.close();
  }
}
