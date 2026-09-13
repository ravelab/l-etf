// Remote MCP endpoint for l-etf, served over Streamable HTTP at /mcp.
// SSE is disabled so no Redis session store is required.

import { createMcpHandler } from "mcp-handler";
import { registerAll } from "@/lib/mcp/register";
import { SERVER_INSTRUCTIONS } from "@/lib/mcp/instructions";
import { enforceMcpRateLimit } from "@/lib/mcp/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const mcpHandler = createMcpHandler(
  (server) => {
    registerAll(server);
  },
  {
    serverInfo: { name: "l-etf", version: "1.0.0" },
    // Handed to the client during initialize, before it calls anything.
    instructions: SERVER_INSTRUCTIONS,
  },
  {
    basePath: "/",
    maxDuration: 300,
    disableSse: true,
    verboseLogs: false,
  },
);

// Rate-limit before delegating to the MCP handler. Heavy sweep tools get a
// stricter per-IP budget than plain lookups.
async function handler(request: Request): Promise<Response> {
  const limited = await enforceMcpRateLimit(request);
  if (limited) return limited;
  return mcpHandler(request);
}

export { handler as GET, handler as POST };
