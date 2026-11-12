// Daily Games bot. Three ways in:
//   - POST /api/interactions: Discord delivers slash commands here.
//   - GET /: connection status (private; Cloudflare Access covers the hostname).
//   - Cron, every minute: makes sure the Gateway connection (src/gateway.ts) is up.

import type { Env } from "./discord";
import { handleInteraction } from "./interactions";

export { DiscordGateway } from "./gateway";

// One object holds the connection. Discord's Gateway is in the eastern US.
function gateway(env: Env) {
  return env.GATEWAY.get(env.GATEWAY.idFromName("main"), { locationHint: "enam" });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/interactions" && request.method === "POST") {
      return handleInteraction(request, env);
    }
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json(await gateway(env).ensureRunning());
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env): Promise<void> {
    await gateway(env).ensureRunning();
  },
} satisfies ExportedHandler<Env>;
