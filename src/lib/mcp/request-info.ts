// Reading what an MCP request is asking for, without consuming the body the
// handler still has to read.
//
// Both the rate limiter and the access log need the tool name, and the body can
// only be read once — so it is parsed here, from a clone, and the result is
// passed to both rather than each cloning and parsing its own copy.

/** Tool names invoked by a Streamable-HTTP request, in order. Empty on any parse failure. */
export async function parseToolCallNames(request: Request): Promise<string[]> {
  if (request.method !== "POST") return [];
  try {
    const text = await request.clone().text();
    if (!text) return [];
    const parsed = JSON.parse(text) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.flatMap((m) => {
      const msg = m as { method?: string; params?: { name?: string } };
      return msg?.method === "tools/call" && msg.params?.name ? [msg.params.name] : [];
    });
  } catch {
    // A malformed body is the MCP handler's problem to report, not ours.
    return [];
  }
}

interface ToolCallLogFields {
  toolNames: string[];
  durationMs: number;
  status: number;
  rateLimited: boolean;
}

/**
 * One line per request, so function logs can be grepped for how long each tool
 * actually takes in production — the endpoint had no timing signal at all, which
 * made every breadth and budget decision a guess.
 */
export function formatToolCallLog(fields: ToolCallLogFields): string {
  const tools = fields.toolNames.length > 0 ? fields.toolNames.join(",") : "-";
  const limited = fields.rateLimited ? " rate_limited=1" : "";
  return `[mcp] tool=${tools} ms=${Math.round(fields.durationMs)} status=${fields.status}${limited}`;
}
