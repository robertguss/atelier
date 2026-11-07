// Probe, not product code: a Pi extension that registers one tool and
// forwards calls to the runner's loopback MCP endpoint.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function probe(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'atelier_echo',
    label: 'Atelier echo',
    description: 'The atelier echo tool. Echo a message back.',
    parameters: Type.Object({ message: Type.String() }),
    async execute(_id, params) {
      const res = await fetch(process.env.ATELIER_ROOM_URL!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${process.env.ATELIER_ROOM_TOKEN}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { message: params.message } } }),
      });
      const json = await res.json() as { result: { content: Array<{ type: 'text'; text: string }> } };
      return { content: json.result.content, details: {} };
    },
  });
}
