import {
  createOpenClawGatewayClient,
  resolveOpenClawGatewayConfig
} from "extension-koyeb";
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

export async function probeOpenClawRuntime(): Promise<OpenClawProbeStatus> {
  if (!config.OPENCLAW_GATEWAY_URL || !config.OPENCLAW_GATEWAY_TOKEN) {
    return {
      configured: false,
      reachable: false,
      url: config.OPENCLAW_GATEWAY_URL ?? null,
      detail: "OpenClaw gateway env is not configured in Koyeb1"
    };
  }

  const gatewayConfig = resolveOpenClawGatewayConfig({
    OPENCLAW_GATEWAY_URL: config.OPENCLAW_GATEWAY_URL,
    OPENCLAW_GATEWAY_TOKEN: config.OPENCLAW_GATEWAY_TOKEN,
    OPENCLAW_CLIENT_ID: "koyeb1-acdc-core",
    OPENCLAW_CLIENT_VERSION: "0.1.0",
    OPENCLAW_CLIENT_PLATFORM: "node",
    OPENCLAW_GATEWAY_SCOPES: "operator.read,operator.write"
  });

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
