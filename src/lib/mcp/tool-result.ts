// Helpers for shaping MCP tool return values.
//
// Every tool returns the MCP `CallToolResult` envelope: a human-readable text
// block (so chat clients render something useful) plus `structuredContent` for
// programmatic consumers. Errors are returned as `isError` results with a
// clear message rather than thrown, so the client sees a tool error instead of
// a transport failure.

export interface ToolResult {
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

/** Build an error tool result from any thrown value. */
export function toolError(error: unknown): ToolResult {
  const message =
    error instanceof McpToolError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unexpected error running tool.";
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}
