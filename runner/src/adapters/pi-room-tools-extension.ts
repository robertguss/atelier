// A Pi extension the runner loads on every turn except independent reviews.
// It offers the room document tools as Pi tools named atelier_<tool>. When Pi
// loads it, it asks the runner's loopback endpoint for the tool list, so the
// runner's tool core stays their only definition, and forwards each call there.
// The endpoint and this turn's token arrive in ATELIER_ROOM_URL and
// ATELIER_ROOM_TOKEN; the token never appears in arguments or tool output.
// Pi loads this file itself, so it imports nothing but Node built-ins.

export const TOOL_PREFIX = 'atelier_';

interface TextResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

interface ToolSpec {
  name: string;
  label: string;
  description: string;
  /** Plain JSON Schema, as Pi's own MCP tools use. */
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<TextResult & { details: undefined }>;
}

interface ExtensionApi {
  registerTool(tool: ToolSpec): void;
}

export default async function atelierRoomTools(pi: ExtensionApi) {
  const url = process.env.ATELIER_ROOM_URL;
  const token = process.env.ATELIER_ROOM_TOKEN;
  if (!url || !token) return;

  let seq = 0;
  const rpc = async (method: string, params: unknown, signal?: AbortSignal) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
      signal,
    });
    if (!res.ok) throw new Error('The document tools no longer work for this turn.');
    const reply = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  };

  const { tools } = (await rpc('tools/list', {})) as { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] };
  for (const tool of tools) {
    pi.registerTool({
      name: TOOL_PREFIX + tool.name,
      label: `Room document: ${tool.name}`,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params, signal) {
        const result = (await rpc('tools/call', { name: tool.name, arguments: params ?? {} }, signal)) as TextResult;
        return { content: result.content, isError: result.isError === true, details: undefined };
      },
    });
  }
}
