// The optional MCP adapter (ADR-005 D1, D7): reads the registry, emits the MCP tool list, forwards calls.
// It is a thin shim inside the host; removing it deletes this file and nothing else. Off unless the host
// is launched with --mcp (stdio) by an MCP client such as Claude Code.

import {
  type ToolDef,
  type ToolReliability,
  type ToolResult,
  WORKFLOW_PROMPT,
  WORKFLOW_PROMPT_NAME,
} from "@fpv/tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Session } from "./session.js";

export const HOST_VERSION = "0.0.1";

export interface McpOptions {
  /** Which tools to advertise (ADR-006 D6); every tool stays callable. Default: all. */
  profile?: ToolReliability;
}

/** Envelope to MCP content: JSON text, plus image blocks for render results. */
export function toCallToolResult(result: ToolResult): CallToolResult {
  const content: CallToolResult["content"] = [];
  let text: unknown = result;
  if (result.ok && isRenderResult(result.result)) {
    const { images, ...rest } = result.result;
    for (const img of images) content.push({ type: "image", data: img.pngBase64, mimeType: "image/png" });
    text = { ...result, result: rest };
  }
  content.unshift({ type: "text", text: JSON.stringify(text) });
  return result.ok ? { content } : { content, isError: true };
}

function isRenderResult(v: unknown): v is { images: { pngBase64: string }[] } {
  return typeof v === "object" && v !== null && Array.isArray((v as { images?: unknown }).images);
}

export function createMcpServer(session: Session, options: McpOptions = {}): McpServer {
  const server = new McpServer({ name: "floorplan-viz", version: HOST_VERSION });
  const tools: ToolDef[] = session.registry.advertised(options.profile ?? "high");
  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        // passthrough so unknown keys reach the registry, which warns instead of failing (spec 04 section 1)
        inputSchema: def.input.passthrough(),
        annotations: {
          readOnlyHint: !def.mutating,
          destructiveHint: def.name === "delete",
          openWorldHint: false,
        },
      },
      async (args) => toCallToolResult(await session.registry.call(def.name, args)),
    );
  }
  server.registerPrompt(
    WORKFLOW_PROMPT_NAME,
    {
      description:
        "How to work in this floor plan tool: order of operations, validation, anchors, catalog discipline.",
    },
    () => ({ messages: [{ role: "user", content: { type: "text", text: WORKFLOW_PROMPT } }] }),
  );
  return server;
}

/** Serve the session over stdio until the client disconnects. */
export async function serveStdio(session: Session, options: McpOptions = {}): Promise<McpServer> {
  const server = createMcpServer(session, options);
  await server.connect(new StdioServerTransport());
  return server;
}
