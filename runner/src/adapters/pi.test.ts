import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HarnessEvent, TurnInput, TurnRequest } from "@atelier/shared";
import { assert, describe, expect, it, vi } from "vitest";

import { FakeRoomConvex } from "../fake-room-convex.ts";
import { createRoomToolsServer } from "../room-tools-server.ts";
import type { RoomToolsClient } from "../room-tools.ts";
import { turnInput } from "./events.ts";
import { blockedEditReason } from "./pi-guard-extension.ts";
import atelierRoomTools from "./pi-room-tools-extension.ts";
import { piHarness } from "./pi.ts";

// A fake Pi RPC process. It records its arguments and every line it reads,
// and acts out a scenario chosen by the prompt text.
const FAKE_PI = `import {createInterface} from 'node:readline';
import {appendFileSync, writeFileSync} from 'node:fs';
writeFileSync(new URL('./argv.json', import.meta.url), JSON.stringify(process.argv.slice(2)));
writeFileSync(new URL('./env.json', import.meta.url), JSON.stringify({url: process.env.ATELIER_ROOM_URL ?? null, token: process.env.ATELIER_ROOM_TOKEN ?? null}));
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let last = '';
const finish = (text) => {
  last = text;
  out({type:'message_end', message:{role:'assistant', stopReason:'stop', content:[{type:'text', text}], usage:{input:3, output:2, cost:{total:0}}}});
  out({type:'agent_settled', aborted:false});
};
createInterface({input:process.stdin}).on('line', (line) => {
  const command = JSON.parse(line);
  appendFileSync(new URL('./stdin.jsonl', import.meta.url), line + '\\n');
  const ok = (data) => out({type:'response', id:command.id, command:command.type, success:true, data});
  if (command.type === 'prompt') {
    ok({disposition:'started'});
    if (command.message === 'steer') out({type:'tool_execution_start', toolCallId:'call-1', toolName:'bash', args:{command:'sleep 5 && echo one'}});
    else if (command.message === 'doc') {
      out({type:'tool_execution_start', toolCallId:'doc-1', toolName:'atelier_add_block', args:{kind:'paragraph', text:'We chose blue.'}});
      out({type:'tool_execution_end', toolCallId:'doc-1', toolName:'atelier_add_block', result:{content:[]}, isError:false});
      finish('noted');
    }
    else if (command.message === 'ui') out({type:'extension_ui_request', id:'ui-1', method:'confirm', title:'Allow?', message:'Run it?'});
    else finish('done');
  } else if (command.type === 'steer') {
    ok({disposition:'queued'});
    out({type:'tool_execution_end', toolCallId:'call-1', toolName:'bash', result:{content:[]}, isError:false});
    finish('steered by ' + command.message);
  } else if (command.type === 'extension_ui_response') {
    finish('ui answered');
  } else if (command.type === 'get_state') ok({sessionFile:'/tmp/fake-session.jsonl'});
  else if (command.type === 'get_last_assistant_text') ok({text:last});
  else ok(undefined);
});`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// The value at `keys` inside parsed JSON, or undefined where the path breaks.
const at = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    current = isRecord(current) ? current[key] : undefined;
  }
  return current;
};

const parseJson = (text: string): unknown => JSON.parse(text);

interface FakePi {
  dir: string;
  run: (
    req: Partial<TurnRequest>,
    input?: TurnInput,
    onEvent?: (ev: HarnessEvent, input: TurnInput) => Promise<void>
  ) => Promise<HarnessEvent[]>;
  argv: () => Promise<string[]>;
  env: () => Promise<unknown>;
  stdin: () => Promise<unknown[]>;
}

const withFakePi = async (fn: (fake: FakePi) => Promise<void>) => {
  const dir = await mkdtemp(path.join(tmpdir(), "atelier-pi-"));
  const cliPath = path.join(dir, "fake.mjs");
  await writeFile(cliPath, FAKE_PI);
  const harness = piHarness({ cliPath, onRaw() {} });
  try {
    await fn({
      async argv() {
        const argv = parseJson(
          await readFile(path.join(dir, "argv.json"), "utf-8")
        );
        if (
          !Array.isArray(argv) ||
          !argv.every((arg): arg is string => typeof arg === "string")
        ) {
          throw new Error("argv.json should hold an array of strings");
        }
        return argv;
      },
      dir,
      async env() {
        return parseJson(await readFile(path.join(dir, "env.json"), "utf-8"));
      },
      async run(req, input, onEvent) {
        const activeInput = input ?? turnInput();
        const events: HarnessEvent[] = [];
        for await (const ev of harness.runTurn(
          {
            cwd: dir,
            editsEnabled: false,
            mcpServers: [],
            prompt: "plain",
            turnId: "test",
            ...req,
          },
          new AbortController().signal,
          activeInput
        )) {
          events.push(ev);
          await onEvent?.(ev, activeInput);
        }
        return events;
      },
      async stdin() {
        const text = await readFile(path.join(dir, "stdin.jsonl"), "utf-8");
        return text
          .trim()
          .split("\n")
          .map((line) => parseJson(line));
      },
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

const roomTools = {
  token: "ROOM-TOKEN-SECRET",
  url: "http://127.0.0.1:40123/mcp",
};

// What the extension registered with Pi, as far as these tests look.
interface RegisteredTool {
  name: string;
  parameters: Record<string, unknown>;
  execute: (callId: string, params: unknown) => Promise<unknown>;
}

// Serves the tools from a real endpoint, as the runner does, and points
// the extension at it through its environment.
const withEndpoint = async (
  fn: (endpoint: {
    calls: FakeRoomConvex["calls"];
    revoke: () => void;
    tools: RegisteredTool[];
  }) => Promise<void> | void
) => {
  const convex = new FakeRoomConvex({
    "documentTools:addBlockForTurn": () => ({
      blockId: "b9",
      ok: true,
      rev: 1,
    }),
  });
  const client: RoomToolsClient = convex;
  const server = createRoomToolsServer({ client, secret: "s3cret" });
  try {
    const route = await server.issue("turn-7");
    vi.stubEnv("ATELIER_ROOM_URL", route.url);
    vi.stubEnv("ATELIER_ROOM_TOKEN", route.token);
    const tools: RegisteredTool[] = [];
    await atelierRoomTools({
      registerTool: (tool) => {
        tools.push(tool);
      },
    });
    await fn({
      calls: convex.calls,
      revoke: () => {
        server.revoke(route.token);
      },
      tools,
    });
  } finally {
    vi.unstubAllEnvs();
    await server.close();
  }
};

const addBlock = (tools: RegisteredTool[]) => {
  const add = tools.find((t) => t.name === "atelier_add_block");
  assert(add, "the extension registers atelier_add_block");
  return add;
};

describe(piHarness, () => {
  it("Pi prompt rejection terminates instead of waiting for agent_end", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atelier-pi-"));
    const cliPath = path.join(dir, "fake.mjs");
    await writeFile(
      cliPath,
      `import {createInterface} from 'node:readline';
  createInterface({input:process.stdin}).on('line', line => {
  const command=JSON.parse(line);
  console.log(JSON.stringify({type:'response',id:command.id,command:command.type,success:false,error:'No API key. Please log in.'}));
  });`
    );
    try {
      await expect(
        (async () => {
          for await (const event of piHarness({ cliPath, onRaw() {} }).runTurn(
            {
              cwd: dir,
              editsEnabled: false,
              mcpServers: [],
              prompt: "hello",
              turnId: "test",
            },
            new AbortController().signal,
            turnInput()
          )) {
            void event;
          }
        })()
      ).rejects.toThrow(/Please log in/u);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("Pi steers a running turn, reports its tools, and rejects a steer once the run has settled", async () => {
    await withFakePi(async (fake) => {
      const outcomes: string[] = [];
      const events = await fake.run(
        { prompt: "steer" },
        turnInput(),
        async (ev, input) => {
          if (ev.type === "tool_call") {
            outcomes.push(await input.steer("Use the other file"));
          }
        }
      );
      const input = turnInput();
      await fake.run({ prompt: "plain" }, input);
      outcomes.push(await input.steer("Too late"));

      expect(outcomes).toStrictEqual(["steered", "rejected"]);
      const stdin = await fake.stdin();
      expect(
        stdin.some(
          (c) =>
            isRecord(c) &&
            c.type === "steer" &&
            c.message === "Use the other file"
        )
      ).toBeTruthy();
      expect(
        !stdin.some(
          (c) => isRecord(c) && c.type === "steer" && c.message === "Too late"
        )
      ).toBeTruthy();
      expect(
        events.filter(
          (ev) => ev.type === "tool_call" || ev.type === "tool_result"
        )
      ).toStrictEqual([
        {
          id: "call-1",
          name: "bash",
          summary: "sleep 5 && echo one",
          type: "tool_call",
        },
        { id: "call-1", ok: true, type: "tool_result" },
      ]);
      expect(events.at(-1)).toStrictEqual({
        text: "steered by Use the other file",
        type: "final",
      });
    });
  });

  it("Pi keeps a run going past 30 minutes while a tool call is pending", async () => {
    await withFakePi(async (fake) => {
      vi.useFakeTimers({
        shouldAdvanceTime: true,
        toFake: ["setTimeout", "clearTimeout"],
      });
      try {
        const events = await fake.run(
          { prompt: "steer" },
          turnInput(),
          async (ev, input) => {
            if (ev.type === "tool_call") {
              await vi.advanceTimersByTimeAsync(31 * 60_000);
              await input.steer("answer");
            }
          }
        );
        expect(events.some((ev) => ev.type === "error")).toBeFalsy();
        expect(events.at(-1)).toStrictEqual({
          text: "steered by answer",
          type: "final",
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("Pi with edits on adds edit and write plus the guard extension; with edits off its arguments are unchanged", async () => {
    await withFakePi(async (fake) => {
      await fake.run({
        editsEnabled: false,
        model: "openai/gpt-6-astra",
        resumeSessionId: "/tmp/s.jsonl",
      });
      await expect(fake.argv()).resolves.toStrictEqual([
        "--mode",
        "rpc",
        "--model",
        "openai/gpt-6-astra",
        "--tools",
        "read,grep,find,ls",
        "--session",
        "/tmp/s.jsonl",
      ]);

      await fake.run({
        editsEnabled: true,
        model: "openai/gpt-6-astra",
        resumeSessionId: "/tmp/s.jsonl",
      });
      const argv = await fake.argv();
      expect(argv.slice(0, 6)).toStrictEqual([
        "--mode",
        "rpc",
        "--model",
        "openai/gpt-6-astra",
        "--tools",
        "read,grep,find,ls,edit,write",
      ]);
      const extension = argv[argv.indexOf("--extension") + 1];
      expect(extension ?? "").toMatch(/\/pi-guard-extension\.ts$/u);
      expect(argv.slice(-2)).toStrictEqual(["--session", "/tmp/s.jsonl"]);
    });
  });

  describe("the room document extension", () => {
    const environment = {
      token: roomTools.token,
      url: roomTools.url,
    };

    it("is loaded and its tools allowed with edits off, the token only in its environment", async () => {
      await withFakePi(async (fake) => {
        await fake.run({
          editsEnabled: false,
          resumeSessionId: "/tmp/s.jsonl",
          roomTools,
        });
        const argv = await fake.argv();
        const extension = argv[argv.indexOf("--extension") + 1] ?? "";
        expect({
          argv,
          argvHoldsToken: JSON.stringify(argv).includes("ROOM-TOKEN-SECRET"),
          env: await fake.env(),
          isRoomExtension: extension.endsWith("/pi-room-tools-extension.ts"),
        }).toStrictEqual({
          argv: [
            "--mode",
            "rpc",
            "--tools",
            "read,grep,find,ls,atelier_*",
            "--extension",
            extension,
            "--session",
            "/tmp/s.jsonl",
          ],
          argvHoldsToken: false,
          env: environment,
          isRoomExtension: true,
        });
      });
    });

    it("is loaded beside the edit guard with edits on, the token only in its environment", async () => {
      await withFakePi(async (fake) => {
        await fake.run({ editsEnabled: true, roomTools });
        const argv = await fake.argv();
        const extensions = argv.filter((_, i) => argv[i - 1] === "--extension");
        expect({
          argvHoldsToken: JSON.stringify(argv).includes("ROOM-TOKEN-SECRET"),
          env: await fake.env(),
          extensions: extensions.map((e) => path.basename(e)).toSorted(),
          tools: argv.slice(0, 4),
        }).toStrictEqual({
          argvHoldsToken: false,
          env: environment,
          extensions: ["pi-guard-extension.ts", "pi-room-tools-extension.ts"],
          tools: [
            "--mode",
            "rpc",
            "--tools",
            "read,grep,find,ls,edit,write,atelier_*",
          ],
        });
      });
    });
  });

  it("a Pi review runs with no tools, extensions or MCP and gets no document route, even if one is passed", async () => {
    await withFakePi(async (fake) => {
      await fake.run({
        independentReview: true,
        resumeSessionId: "/tmp/s.jsonl",
        roomTools,
      });
      await expect(fake.argv()).resolves.toStrictEqual([
        "--mode",
        "rpc",
        "--no-tools",
        "--no-extensions",
        "--no-mcp",
        "--no-session",
      ]);
      await expect(fake.env()).resolves.toStrictEqual({
        token: null,
        url: null,
      });
    });
  });

  it("a Pi document tool call shows up as a turn item with the tool name and no token", async () => {
    await withFakePi(async (fake) => {
      const events = await fake.run({ prompt: "doc", roomTools });
      expect(
        events.filter(
          (ev) => ev.type === "tool_call" || ev.type === "tool_result"
        )
      ).toStrictEqual([
        {
          id: "doc-1",
          name: "atelier_add_block",
          summary: "",
          type: "tool_call",
        },
        { id: "doc-1", ok: true, type: "tool_result" },
      ]);
      expect(JSON.stringify(events)).not.toMatch(/ROOM-TOKEN-SECRET/u);
    });
  });

  it("a Pi scribe turn starts a fresh session it never saves, with edits off and the room tools extension", async () => {
    await withFakePi(async (fake) => {
      await fake.run({ editsEnabled: false, roomTools, scribe: true });
      const argv = await fake.argv();
      const extension = argv[argv.indexOf("--extension") + 1] ?? "";
      expect(argv).toStrictEqual([
        "--mode",
        "rpc",
        "--tools",
        "read,grep,find,ls,atelier_*",
        "--extension",
        extension,
        "--no-session",
      ]);
      expect(extension).toMatch(/\/pi-room-tools-extension\.ts$/u);
    });
  });

  describe("the Pi room tools extension", () => {
    it("registers the endpoint's tools with their schemas", async () => {
      await withEndpoint(({ tools }) => {
        const add = addBlock(tools);
        expect({
          names: tools.map((t) => t.name),
          required: add.parameters.required,
          type: add.parameters.type,
        }).toStrictEqual({
          names: [
            "atelier_read_document",
            "atelier_read_thread",
            "atelier_add_block",
            "atelier_update_block",
            "atelier_delete_block",
            "atelier_comment",
          ],
          required: ["kind", "text"],
          type: "object",
        });
      });
    });

    it("forwards a call as this turn, and keeps bad arguments from Convex", async () => {
      await withEndpoint(async ({ calls, tools }) => {
        const add = addBlock(tools);
        const added = await add.execute("call-1", {
          kind: "paragraph",
          text: "We chose blue.",
        });
        const callsAfterGoodCall = [...calls];
        const refused = await add.execute("call-2", { kind: "paragraph" });
        expect({
          added,
          callsAfterBadCall: calls.length,
          callsAfterGoodCall,
          refused: at(refused, "isError"),
        }).toStrictEqual({
          added: {
            content: [
              {
                text: "Added block b9 at rev 1. Pass that rev as baseRev to change it later.",
                type: "text",
              },
            ],
            details: undefined,
            isError: false,
          },
          callsAfterBadCall: 1,
          callsAfterGoodCall: [
            {
              args: {
                kind: "paragraph",
                secret: "s3cret",
                text: "We chose blue.",
                turnId: "turn-7",
              },
              name: "documentTools:addBlockForTurn",
            },
          ],
          refused: true,
        });
      });
    });

    it("fails once the turn's token is revoked", async () => {
      await withEndpoint(async ({ revoke, tools }) => {
        revoke();
        await expect(
          addBlock(tools).execute("call-3", { kind: "paragraph", text: "Late" })
        ).rejects.toThrow(/no longer work/u);
      });
    });
  });

  it("Pi cancels an extension UI request so the turn completes", async () => {
    await withFakePi(async (fake) => {
      const events = await fake.run({ prompt: "ui" });
      expect(events.at(-1)).toStrictEqual({
        text: "ui answered",
        type: "final",
      });
      const stdin = await fake.stdin();
      expect(
        stdin.find((c) => isRecord(c) && c.type === "extension_ui_response")
      ).toStrictEqual({
        cancelled: true,
        id: "ui-1",
        type: "extension_ui_response",
      });
    });
  });
});

describe(blockedEditReason, () => {
  it("Pi edit guard allows in-folder files and blocks outside, control folders and symlinks out", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "atelier-pi-guard-"));
    const outside = await mkdtemp(path.join(tmpdir(), "atelier-pi-outside-"));
    try {
      const cwd = path.join(dir, "room");
      await mkdir(path.join(cwd, "docs"), { recursive: true });
      await mkdir(path.join(cwd, ".git"));
      await symlink(outside, path.join(cwd, "escape"));
      await symlink(path.join(cwd, ".git"), path.join(cwd, "gitlink"));
      await symlink(
        path.join(outside, "not-yet.txt"),
        path.join(cwd, "dangling.txt")
      );

      const allowed = [
        "notes.md",
        "docs/plan.md",
        path.join(cwd, "docs/new.md"),
        "@docs/at.md",
      ];
      // Each path paired with its reason, so a failure names the path.
      expect(
        allowed.map((file) => [file, blockedEditReason(cwd, file)])
      ).toStrictEqual(allowed.map((file) => [file, undefined]));
      const blocked = [
        "/tmp/outside",
        "../outside.txt",
        "escape/x.txt",
        "dangling.txt",
        "~/x.txt",
        ".pi/settings.json",
        ".git/HEAD",
        ".git/hooks/pre-commit",
        "gitlink/config",
        ".claude/settings.json",
        ".mcp.json",
        ".codex/config.toml",
        ".agents/skills/x.md",
        "docs/../.git/config",
        "sub/.git/x",
        "docs/.claude/settings.json",
        "packages/app/.mcp.json",
      ];
      // Lists every blocked path that was let through.
      expect(
        blocked.filter((file) => {
          const reason = blockedEditReason(cwd, file);
          return reason === undefined || reason === "";
        })
      ).toStrictEqual([]);
      expect(blockedEditReason(cwd, undefined)).toBeTruthy();
      // The room folder itself may be reached through a symlink.
      await symlink(cwd, path.join(dir, "roomlink"));
      expect(
        blockedEditReason(path.join(dir, "roomlink"), "notes.md")
      ).toBeUndefined();
      expect(
        blockedEditReason(path.join(dir, "roomlink"), ".git/HEAD")
      ).toBeTruthy();
    } finally {
      await rm(dir, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });
});
