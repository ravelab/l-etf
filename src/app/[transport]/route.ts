// Remote MCP endpoint for l-etf, served over Streamable HTTP at /mcp.
// SSE is disabled so no Redis session store is required.

import { createMcpHandler } from "mcp-handler";
import { registerAll } from "@/lib/mcp/register";
import { SERVER_INSTRUCTIONS } from "@/lib/mcp/instructions";
import { enforceMcpRateLimit } from "@/lib/mcp/rate-limit";
import { formatToolCallLog, parseToolCallNames } from "@/lib/mcp/request-info";

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
//
// The body is parsed for tool names once here and shared with the limiter,
// since a Request body can only be read once and both need it. Every request is
// logged with the tool it ran and how long it took: the endpoint previously had
// no timing signal, which made every breadth and budget decision a guess.
async function handler(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const toolNames = await parseToolCallNames(request);

  const limited = await enforceMcpRateLimit(request, toolNames);
  if (limited) {
    console.info(
      formatToolCallLog({
        toolNames,
        durationMs: Date.now() - startedAt,
        status: limited.status,
        rateLimited: true,
      }),
    );
    return limited;
  }

  const response = await mcpHandler(request);
  console.info(
    formatToolCallLog({
      toolNames,
      durationMs: Date.now() - startedAt,
      status: response.status,
      rateLimited: false,
    }),
  );
  return response;
}

export { handler as GET, handler as POST };
