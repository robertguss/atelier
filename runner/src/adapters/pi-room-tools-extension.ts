// A Pi extension the runner loads on every turn except independent reviews.
// It offers the room document tools as Pi tools named atelier_<tool>. When Pi
// loads it, it asks the runner's loopback endpoint for the tool list, so the
// runner's tool core stays their only definition, and forwards each call there.
// The endpoint and this turn's token arrive in ATELIER_ROOM_URL and
// ATELIER_ROOM_TOKEN; the token never appears in arguments or tool output.
// Pi loads this file itself, so it imports nothing but Node built-ins.

export const TOOL_PREFIX = "atelier_";

interface TextResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface ToolSpec {
  name: string;
  label: string;
  description: string;
  /** Plain JSON Schema, as Pi's own MCP tools use. */
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal
  ) => Promise<TextResult & { details: undefined }>;
}

interface ExtensionApi {
  registerTool: (tool: ToolSpec) => void;
}

interface ListedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isTextResult = (value: unknown): value is TextResult =>
  isRecord(value) && Array.isArray(value.content);

const isListedTool = (value: unknown): value is ListedTool =>
  isRecord(value) &&
  typeof value.name === "string" &&
  typeof value.description === "string" &&
  isRecord(value.inputSchema);

const present = (value: string | undefined): value is string =>
  value !== undefined && value !== "";

const atelierRoomTools = async (pi: ExtensionApi) => {
  const url = process.env.ATELIER_ROOM_URL;
  const token = process.env.ATELIER_ROOM_TOKEN;
  if (!present(url) || !present(token)) {
    return;
  }

  let seq = 0;
  const rpc = async (method: string, params: unknown, signal?: AbortSignal) => {
    seq += 1;
    const res = await fetch(url, {
      body: JSON.stringify({ id: seq, jsonrpc: "2.0", method, params }),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal,
    });
    if (!res.ok) {
      throw new Error("The document tools no longer work for this turn.");
    }
    const reply: unknown = await res.json();
    if (!isRecord(reply)) {
      throw new Error("The document tools sent a reply Pi could not read.");
    }
    if (isRecord(reply.error)) {
      throw new Error(String(reply.error.message));
    }
    return reply.result;
  };

  const listed = await rpc("tools/list", {});
  const tools =
    isRecord(listed) && Array.isArray(listed.tools) ? listed.tools : [];
  for (const tool of tools.filter(isListedTool)) {
    pi.registerTool({
      description: tool.description,
      async execute(_toolCallId, params, signal) {
        const result = await rpc(
          "tools/call",
          { arguments: params ?? {}, name: tool.name },
          signal
        );
        if (!isTextResult(result)) {
          throw new Error("The document tool sent a result Pi could not read.");
        }
        return {
          content: result.content,
          details: undefined,
          isError: result.isError === true,
        };
      },
      label: `Room document: ${tool.name}`,
      name: TOOL_PREFIX + tool.name,
      parameters: tool.inputSchema,
    });
  }
};

export default atelierRoomTools;
