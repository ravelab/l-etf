// Helpers for shaping MCP tool return values.
//
// Every tool returns the MCP `CallToolResult` envelope: a human-readable text
// block (so chat clients render something useful) plus `structuredContent` for
// programmatic consumers. Errors are returned as `isError` results with a
// clear message rather than thrown, so the client sees a tool error instead of
// a transport failure.

interface ToolResult {
  // Index signature to match the SDK's CallToolResult (which allows passthrough
  // keys such as `_meta`); without it the shapes are structurally incompatible.
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Build a successful tool result. `summary` is the human-facing text; `data`
 * is the machine-readable structured payload (also serialized into the text
 * block so non-structured clients still receive it).
 */
export function toolSuccess(summary: string, data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
    structuredContent: data,
  };
}

/**
 * A recoverable, user-facing tool error (bad input, missing data). The message
 * is safe to show to the model/user; it must not leak internal details.
 */
export class McpToolError extends Error {}

/**
 * Build an error tool result from any thrown value.
 *
 * Only `McpToolError` messages are safe to hand back: anything else is an
 * internal failure whose message can carry absolute server paths, bundle
 * layout, or upstream detail (an ENOENT from a snapshot read reads out
 * `/var/task/...`). Those are logged server-side and reported generically —
 * the endpoint is unauthenticated.
 */
export function toolError(error: unknown): ToolResult {
  let message: string;
  if (error instanceof McpToolError) {
    message = error.message;
  } else {
    message = "Unexpected error running tool.";
    console.error("[mcp] unhandled tool error:", error);
  }
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
