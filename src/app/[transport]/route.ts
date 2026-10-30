// Remote MCP endpoint for l-etf at /mcp. mcp-handler 2 serves the 2026-07-28
// protocol natively and 2025-era Streamable HTTP clients statelessly, so there
// is no session store.

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
    // No long-lived `subscriptions/listen` streams on a serverless function, the
    // way 1.x ran with SSE disabled; there is nothing to subscribe to anyway.
    maxSubscriptions: 0,
    verboseLogs: false,
  },
);

/** The one path this catch-all segment serves; every other single-segment URL is not MCP. */
const MCP_PATH_SEGMENT = "mcp";

// Rate-limit before delegating to the MCP handler. Heavy sweep tools get a
// stricter per-IP budget than plain lookups.
//
// The body is parsed for tool names once here and shared with the limiter,
// since a Request body can only be read once and both need it. Every request is
// logged with the tool it ran and how long it took: the endpoint previously had
// no timing signal, which made every breadth and budget decision a guess.
// mcp-handler 2 answers every request it is given and leaves routing to the
// framework, while this `[transport]` segment matches any single-segment path —
// so check the path here, or `/anything` would answer as an MCP endpoint.
async function handler(
  request: Request,
  { params }: { params: Promise<{ transport: string }> },
): Promise<Response> {
  if ((await params).transport !== MCP_PATH_SEGMENT) {
    return new Response("Not Found", { status: 404 });
  }
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
