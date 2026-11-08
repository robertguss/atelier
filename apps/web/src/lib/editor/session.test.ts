import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSession } from "./session";
import type { SessionApi } from "./session";

const B1 = "b1";
const B2 = "b2";

// A call the test holds in flight and settles by hand.
const deferred = <T>() => {
  const call: { resolve: (value: T) => void } = { resolve: () => {} };
  // oxlint-disable-next-line promise/avoid-new -- The test holds the call open and settles it by hand.
  const promise = new Promise<T>((resolve) => {
    call.resolve = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      call.resolve(value);
    },
  };
};

// A split's new block as the test's rows show it.
interface Row {
  _id: string;
  text: string;
}
const tailRow = (temp: { key: string; text: string }): Row => ({
  _id: temp.key,
  text: temp.text,
});

// Convex wraps a function's thrown error in a longer message.
const refusal = (sentence: string) =>
  new Error(
    `[CONVEX M(blocks:startEdit)] Server Error\nUncaught Error: ${sentence}\n    at handler (leases.ts:1:1)`
  );

let api: {
  [Name in keyof SessionApi<string>]: ReturnType<
    typeof vi.fn<SessionApi<string>[Name]>
  >;
};

const open = () => createSession<string>(api, (n) => `temp-${n}`);

// Lets queued calls run without moving the clock.
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("the editing session", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    api = {
      save: vi.fn<SessionApi<string>["save"]>().mockResolvedValue({ rev: 8 }),
      split: vi.fn<SessionApi<string>["split"]>(),
      startEdit: vi.fn<SessionApi<string>["startEdit"]>().mockResolvedValue({}),
      stopEdit: vi.fn<SessionApi<string>["stopEdit"]>().mockResolvedValue(null),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("typing in a block", () => {
    it("takes the lease on the first keystroke and saves once after a second of quiet, on the rev the block was shown at", async () => {
      const session = open();
      session.change(B1, "C", 5);
      await settle();
      expect(api.startEdit).toHaveBeenCalledExactlyOnceWith({ blockId: B1 });

      await vi.advanceTimersByTimeAsync(500);
      session.change(B1, "Ch", 5);
      await vi.advanceTimersByTimeAsync(999);
      expect(api.save).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(api.save).toHaveBeenCalledExactlyOnceWith({
        baseRev: 5,
        blockId: B1,
        text: "Ch",
      });
      expect(api.startEdit).toHaveBeenCalledOnce();
    });

    it("shows the typed text over the server's until its save is acked", async () => {
      const save = deferred<{ rev: number }>();
      api.save.mockReturnValue(save.promise);
      const session = open();
      session.change(B1, "Charge per seat", 5);
      expect(session.local(B1).text).toBe("Charge per seat");

      await vi.advanceTimersByTimeAsync(1000);
      expect(session.local(B1).text).toBe("Charge per seat");
      save.resolve({ rev: 6 });
      await settle();
      expect(session.local(B1).text).toBeUndefined();
    });

    it("sends two saves of one block one after the other, the second on the rev the first returned", async () => {
      const first = deferred<{ rev: number }>();
      api.save.mockReturnValueOnce(first.promise);
      const session = open();
      session.change(B1, "Charge", 5);
      await vi.advanceTimersByTimeAsync(1000);
      session.change(B1, "Charge per seat", 5);
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.save).toHaveBeenCalledOnce();

      first.resolve({ rev: 9 });
      await settle();
      expect(api.save).toHaveBeenLastCalledWith({
        baseRev: 9,
        blockId: B1,
        text: "Charge per seat",
      });
    });

    it("sends a pending save at once when flushed, without waiting for the quiet second", async () => {
      const session = open();
      session.change(B1, "Charge", 5);
      session.flush(B1);
      await settle();
      expect(api.save).toHaveBeenCalledExactlyOnceWith({
        baseRev: 5,
        blockId: B1,
        text: "Charge",
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.save).toHaveBeenCalledOnce();
    });

    it("takes the lease again before saving when typing resumes after two minutes", async () => {
      const session = open();
      session.change(B1, "Charge", 5);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(10_000);
      session.change(B1, "Charge per", 8);
      await settle();
      expect(api.startEdit).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(120_000);
      session.change(B1, "Charge per seat", 8);
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.startEdit).toHaveBeenCalledTimes(2);
      const [, renewal] = api.startEdit.mock.invocationCallOrder;
      expect(renewal).toBeLessThan(
        api.save.mock.invocationCallOrder.at(-1) ?? 0
      );
      expect(api.save).toHaveBeenLastCalledWith({
        baseRev: 8,
        blockId: B1,
        text: "Charge per seat",
      });
    });
  });

  describe("refusals", () => {
    it("keeps the typed text as a draft and hands the block back to the server's text when someone else took the lease first", async () => {
      api.startEdit.mockRejectedValue(refusal("Ana is editing this block"));
      const session = open();
      session.change(B1, "Ben's words", 5);
      await settle();
      expect(session.local(B1)).toStrictEqual({
        draft: { message: "Ana is editing this block", text: "Ben's words" },
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(api.save).not.toHaveBeenCalled();
    });

    it("keeps the local text as a draft when the save meets a newer rev, and saves later typing on the server's rev", async () => {
      api.save.mockRejectedValueOnce(
        new ConvexError({
          message: "This block changed since you last saw it",
          rev: 7,
          text: "From the other browser",
        })
      );
      const session = open();
      const notified = vi.fn<() => void>();
      session.subscribe(notified);
      session.change(B1, "From this browser", 5);
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.local(B1)).toStrictEqual({
        draft: {
          message: "This block changed since you last saw it",
          text: "From this browser",
        },
      });
      expect(notified).toHaveBeenCalledWith();

      session.discard(B1);
      expect(session.local(B1).draft).toBeUndefined();
      session.change(B1, "From the other browser, edited", 7);
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.save).toHaveBeenLastCalledWith({
        baseRev: 7,
        blockId: B1,
        text: "From the other browser, edited",
      });
    });
  });

  describe("releasing the lease", () => {
    it("saves on blur and releases three seconds later", async () => {
      const session = open();
      session.change(B1, "Charge", 5);
      session.blur(B1);
      await settle();
      expect(api.save).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2999);
      expect(api.stopEdit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(api.stopEdit).toHaveBeenCalledExactlyOnceWith({ blockId: B1 });
    });

    it("keeps the lease when the block is focused again within three seconds", async () => {
      const session = open();
      session.change(B1, "Charge", 5);
      session.blur(B1);
      await vi.advanceTimersByTimeAsync(2000);
      session.focus(B1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.stopEdit).not.toHaveBeenCalled();
    });

    it("releases nothing on blur of a block the person never typed in", async () => {
      const session = open();
      session.focus(B2);
      session.blur(B2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(api.stopEdit).not.toHaveBeenCalled();
      expect(api.save).not.toHaveBeenCalled();
    });

    it("releases a lease the server granted with another write once the block is left", async () => {
      const session = open();
      session.leased(B2);
      session.blur(B2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(api.stopEdit).toHaveBeenCalledExactlyOnceWith({ blockId: B2 });
    });

    it("saves a dirty block and releases it when the tab is hidden", async () => {
      const session = open();
      session.change(B1, "Charge", 5);
      session.hide();
      await settle();
      expect(api.save).toHaveBeenCalledExactlyOnceWith({
        baseRev: 5,
        blockId: B1,
        text: "Charge",
      });
      expect(api.stopEdit).toHaveBeenCalledExactlyOnceWith({ blockId: B1 });
      const [save] = api.save.mock.invocationCallOrder;
      const [stop] = api.stopEdit.mock.invocationCallOrder;
      expect(save).toBeLessThan(stop ?? 0);
    });
  });

  describe("splitting a block", () => {
    it("shows the new block after its head at once, and in the server's place once the split lands", async () => {
      const split = deferred<{
        rev: number;
        tailId: string;
        tailRev: number;
      }>();
      api.split.mockReturnValue(split.promise);
      const session = open();
      const head = { _id: B1, text: "Charge per seat." };
      const next = { _id: B2, text: "Try a free tier" };
      const rows: Row[] = [head, next];
      const tail = session.split(B1, 5, {
        headText: "Charge",
        tailKind: "paragraph",
        tailText: " per seat.",
      });
      expect(session.blocks(rows, tailRow)).toStrictEqual([
        head,
        { _id: tail, text: " per seat." },
        next,
      ]);
      expect(session.local(B1).text).toBe("Charge");
      await settle();
      split.resolve({ rev: 6, tailId: "b9", tailRev: 6 });
      await settle();
      expect(session.keyOf("b9")).toBe(tail);
      expect(session.local(B1).text).toBeUndefined();
      const landed = [head, { _id: "b9", text: " per seat." }, next];
      expect(session.blocks(landed, tailRow)).toStrictEqual(landed);
    });

    it("holds typing in the new block until the split lands, then saves it under the real id on the lease the split gave", async () => {
      const split = deferred<{
        rev: number;
        tailId: string;
        tailRev: number;
      }>();
      api.split.mockReturnValue(split.promise);
      const session = open();
      const tail = session.split(B1, 5, {
        headText: "Charge",
        tailKind: "paragraph",
        tailText: " per seat.",
      });
      session.change(tail, " per seat, yearly.", 0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.split).toHaveBeenCalledExactlyOnceWith({
        baseRev: 5,
        blockId: B1,
        headText: "Charge",
        tailKind: "paragraph",
        tailText: " per seat.",
      });
      expect(api.save).not.toHaveBeenCalled();

      split.resolve({ rev: 6, tailId: "b9", tailRev: 6 });
      await settle();
      expect(api.save).toHaveBeenCalledExactlyOnceWith({
        baseRev: 6,
        blockId: "b9",
        text: " per seat, yearly.",
      });
      expect(api.startEdit).not.toHaveBeenCalled();
    });

    it("splits only after a save already in flight lands, on the rev it returned", async () => {
      const save = deferred<{ rev: number }>();
      api.save.mockReturnValue(save.promise);
      api.split.mockResolvedValue({ rev: 7, tailId: "b9", tailRev: 7 });
      const session = open();
      session.change(B1, "Charge per seat.", 5);
      await vi.advanceTimersByTimeAsync(1000);
      session.split(B1, 5, {
        headText: "Charge",
        tailKind: "paragraph",
        tailText: " per seat.",
      });
      await settle();
      expect(api.split).not.toHaveBeenCalled();

      save.resolve({ rev: 6 });
      await settle();
      expect(api.split).toHaveBeenCalledWith(
        expect.objectContaining({ baseRev: 6, blockId: B1 })
      );
    });

    it("runs a write on the new block under its real id once the split lands", async () => {
      api.split.mockResolvedValue({ rev: 6, tailId: "b9", tailRev: 6 });
      const session = open();
      const tail = session.split(B1, 5, {
        headText: "Charge",
        tailKind: "todo",
        tailText: " per seat.",
      });
      let seen;
      await session.run([[tail, 0]], async (block) => {
        seen = block(tail);
        return await Promise.resolve([[tail, 7] as const]);
      });
      expect(seen).toStrictEqual({ id: "b9", rev: 6 });
    });

    it("drops the tail and keeps the whole text as a draft when the split is refused", async () => {
      api.split.mockRejectedValue(
        new ConvexError({
          message: "This block changed since you last saw it",
          rev: 7,
          text: "Charge per team.",
        })
      );
      const session = open();
      const rows: Row[] = [{ _id: B1, text: "Charge per seat." }];
      const tail = session.split(B1, 5, {
        headText: "Charge",
        tailKind: "paragraph",
        tailText: " per seat.",
      });
      session.change(tail, " per seat, yearly.", 0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(session.blocks(rows, tailRow)).toStrictEqual(rows);
      expect(session.local(B1)).toStrictEqual({
        draft: {
          message: "This block changed since you last saw it",
          text: "Charge per seat, yearly.",
        },
      });
      expect(api.save).not.toHaveBeenCalled();
    });
  });

  describe("other writes to whole blocks", () => {
    it("runs after both blocks' pending saves land, on the revs they returned", async () => {
      api.save.mockImplementation(
        async ({ blockId }) =>
          await Promise.resolve({ rev: blockId === B1 ? 6 : 9 })
      );
      const session = open();
      session.change(B1, "Charge", 5);
      session.change(B2, " per seat.", 8);
      let seen;
      await session.run(
        [
          [B2, 8],
          [B1, 5],
        ],
        async (block) => {
          seen = [block(B2), block(B1)];
          return await Promise.resolve([
            [B2, null],
            [B1, 10],
          ] as const);
        }
      );
      expect(api.save).toHaveBeenCalledTimes(2);
      expect(seen).toStrictEqual([
        { id: B2, rev: 9 },
        { id: B1, rev: 6 },
      ]);

      session.change(B1, "Charge per seat, yearly.", 6);
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.save).toHaveBeenLastCalledWith({
        baseRev: 10,
        blockId: B1,
        text: "Charge per seat, yearly.",
      });
    });

    it("forgets a block the write removed, so leaving it releases nothing", async () => {
      const session = open();
      session.change(B2, " per seat.", 8);
      await settle();
      await session.run(
        [[B2, 8]],
        async () => await Promise.resolve([[B2, null] as const])
      );
      session.blur(B2);
      await vi.advanceTimersByTimeAsync(3000);
      expect(api.stopEdit).not.toHaveBeenCalled();
    });

    it("shows a kind change at once and sends its text in place of the pending save", async () => {
      const setKind = deferred<(readonly [string, number])[]>();
      const call = vi.fn<(rev: number) => void>();
      const session = open();
      session.change(B1, "[]Ship it", 5);
      const converted = session.run(
        [[B1, 5]],
        async (block) => {
          call(block(B1).rev);
          return await setKind.promise;
        },
        { kind: "todo", text: "Ship it" }
      );
      expect(session.local(B1)).toStrictEqual({
        kind: "todo",
        text: "Ship it",
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(api.save).not.toHaveBeenCalled();
      expect(call).toHaveBeenCalledExactlyOnceWith(5);

      setKind.resolve([[B1, 6]]);
      await converted;
      expect(session.local(B1).kind).toBeUndefined();
      expect(session.local(B1).text).toBeUndefined();
    });

    it("hands the block back to the server's kind on refusal, keeps the text as a draft and rejects with the reason", async () => {
      const session = open();
      const converted = session.run(
        [[B1, 5]],
        async () =>
          await Promise.reject(
            refusal("This block changed since you last saw it")
          ),
        { kind: "quote", text: "Ship it" }
      );
      await expect(converted).rejects.toThrow(
        "This block changed since you last saw it"
      );
      expect(session.local(B1)).toStrictEqual({
        draft: {
          message: "This block changed since you last saw it",
          text: "Ship it",
        },
      });
    });

    it("shows a tick at once, until the write lands and the server's copy carries it", async () => {
      const session = open();
      const ticked = session.run(
        [[B1, 5]],
        async () => await Promise.resolve([[B1, 6] as const]),
        { checked: true }
      );
      expect(session.local(B1).checked).toBeTruthy();
      await ticked;
      expect(session.local(B1).checked).toBeUndefined();
    });
  });
});
