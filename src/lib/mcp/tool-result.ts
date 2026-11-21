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
 * Replace every non-finite number (NaN, +/-Infinity) with null, recursively,
 * returning new objects and arrays rather than touching the input.
 *
 * `JSON.stringify` already renders those as null, so an un-sanitized payload
 * makes `structuredContent` and the serialized text disagree — and the SDK
 * validates `structuredContent` against the declared `outputSchema`, where
 * `z.number()` rejects NaN outright. A degenerate window really does have no
 * Sharpe ratio, so null is the honest value rather than a loosened schema.
 */
export function sanitizeNonFinite<T>(value: T): T {
  if (typeof value === "number") {
    return (Number.isFinite(value) ? value : null) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNonFinite(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sanitizeNonFinite(item),
      ]),
    ) as T;
  }
  return value;
}

/**
 * Build a successful result for a tool that declares an `outputSchema`.
 *
 * The payload travels once, in `structuredContent`; the text block carries only
 * the human-readable summary. The spec suggests also serializing the payload
 * into text for clients that cannot read structured content, but this server's
 * payloads reach ~8k tokens and duplicating them doubles the cost of every call
 * for a client that reads `structuredContent` anyway. The schema is what tells
 * a client the data is there.
 */
export function toolSuccessTyped(summary: string, data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: sanitizeNonFinite(data),
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
