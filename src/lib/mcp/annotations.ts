// Shared MCP tool annotations.
//
// Annotations are hints a client reads from `tools/list` to decide how much
// autonomy a tool gets — notably whether it can run without a per-call prompt.
// Nothing on this server mutates anything, so saying so plainly is what lets an
// agent actually use it without interrupting its user on every call.

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * A tool that only reads this server's own bundled market data and re-runs the
 * simulation engine: no side effects, no external calls, and the same inputs
 * give the same answer.
 */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * A read-only tool that reaches a third party. Not idempotent — the upstream
 * answer moves on its own — and open-world, so a client knows the call leaves
 * this server.
 */
export const EXTERNAL_READ_ANNOTATIONS: ToolAnnotations = {
  ...READ_ONLY_ANNOTATIONS,
  idempotentHint: false,
  openWorldHint: true,
};
