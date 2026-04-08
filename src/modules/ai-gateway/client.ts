import { config } from "../../config";

export type GatewayMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function requestGatewayChat(input: {
  prompt: string;
  policy?: string;
  context?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ text: string; provider?: string; policy?: string }> {
  const response = await fetch(`${config.KOYEB0_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-api-key": config.KOYEB0_INTERNAL_API_KEY
    },
    body: JSON.stringify({
      model: "gateway-default",
      policy: input.policy ?? config.KOYEB0_DEFAULT_POLICY,
      messages: [
        {
          role: "user",
          content: input.context
            ? `${input.context}\n\nUser request: ${input.prompt}`
            : input.prompt
        }
      ],
      metadata: input.metadata ?? {}
    })
  });

  if (!response.ok) {
    throw new Error(`Koyeb0 request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    provider?: string;
    policy?: string;
  };

  return {
    text: payload.choices?.[0]?.message?.content ?? "",
    provider: payload.provider,
    policy: payload.policy
  };
}
