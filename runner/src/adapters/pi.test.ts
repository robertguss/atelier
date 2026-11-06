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
import { describe, expect, it } from "vitest";

import { turnInput } from "./events.ts";
import { blockedEditReason } from "./pi-guard-extension.ts";
import { piHarness } from "./pi.ts";

// A fake Pi RPC process. It records its arguments and every line it reads,
// and acts out a scenario chosen by the prompt text.
const FAKE_PI = `import {createInterface} from 'node:readline';
import {appendFileSync, writeFileSync} from 'node:fs';
writeFileSync(new URL('./argv.json', import.meta.url), JSON.stringify(process.argv.slice(2)));
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

const parseJson = (text: string): unknown => JSON.parse(text);

interface FakePi {
  dir: string;
  run: (
    req: Partial<TurnRequest>,
    input?: TurnInput,
    onEvent?: (ev: HarnessEvent, input: TurnInput) => Promise<void>
  ) => Promise<HarnessEvent[]>;
  argv: () => Promise<string[]>;
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
