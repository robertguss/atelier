import type { BlockKind } from "@atelier/shared";

import { errorText } from "~/components/room/errors";
import { logFailure } from "~/lib/utils";

// One person's editing of one document, without React. Their first change to
// a block takes its lease; saves wait for a second of quiet and go out one at
// a time, each on the rev the previous write returned; a refusal keeps what
// they typed as a draft and hands the block back to the server's text.

const SAVE_AFTER_MS = 1000;
// The server lets a lease lapse two minutes after it was last taken; taking
// it again this often while the person types keeps it with room to spare.
const RENEW_EVERY_MS = 30_000;
const RELEASE_AFTER_MS = 3000;

interface SplitArgs {
  headText: string;
  tailKind: BlockKind;
  tailText: string;
  tailChecked?: boolean;
}

/** The mutations the session calls, keyed by block id `K`. */
export interface SessionApi<K extends string> {
  startEdit: (args: { blockId: K }) => Promise<unknown>;
  stopEdit: (args: { blockId: K }) => Promise<unknown>;
  save: (args: {
    blockId: K;
    text: string;
    baseRev: number;
  }) => Promise<{ rev: number }>;
  split: (
    args: SplitArgs & { blockId: K; baseRev: number }
  ) => Promise<{ rev: number; tailId: K; tailRev: number }>;
}

/** What a write shows on its block, over the server's copy, until it lands. */
interface Shown {
  kind?: BlockKind;
  /** Typed text not yet acked; the block shows it instead of the server's. */
  text?: string;
  checked?: boolean;
}

/** What the session holds for a block over the server's copy. */
interface Local extends Shown {
  /** Text a refused write left behind, with the server's reason. */
  draft?: { text: string; message: string };
}

/** A split's new block, shown before the server returns its id. */
interface Temp<K> {
  key: K;
  afterKey: K;
  kind: BlockKind;
  text: string;
  checked?: boolean;
  /** The block's real id, once the split lands. */
  id?: K;
}

interface Entry {
  baseRev: number;
  held: boolean;
  takenAt: number;
  saveTimer?: ReturnType<typeof setTimeout>;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

const NOTHING: Local = {};

// A split's new block whose split was refused has no id to write under.
const NOT_SAVED = "The block this came from was not saved";

/**
 * Blocks are addressed by key: a block's id, or for a split's new block the
 * temp key `tempKey` makes, which stays its key after the real id arrives.
 */
export const createSession = <K extends string>(
  api: SessionApi<K>,
  tempKey: (n: number) => K
) => {
  const entries = new Map<K, Entry>();
  const locals = new Map<K, Local>();
  // Temp key to real id, undefined until the split lands; and back.
  const realIds = new Map<K, K | undefined>();
  const keys = new Map<K, K>();
  let temps: readonly Temp<K>[] = [];
  // Split blocks the server's copy has shown. From then on the server alone
  // decides whether they exist, so a merge that removes one removes it here.
  const shownByServer = new Set<K>();
  const listeners = new Set<() => void>();
  let queue: Promise<unknown> = Promise.resolve();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const entry = (key: K) => {
    let found = entries.get(key);
    if (!found) {
      found = { baseRev: 0, held: false, takenAt: 0 };
      entries.set(key, found);
    }
    return found;
  };
  const local = (key: K) => locals.get(key) ?? NOTHING;
  const setLocal = (key: K, next: Local) => {
    locals.set(key, next);
    notify();
  };
  const idOf = (key: K) => (realIds.has(key) ? realIds.get(key) : key);
  // The rev the person's edit starts from: the server's, unless unacked
  // local text already rests on an earlier one.
  const startFrom = (key: K, rev: number) => {
    const state = entry(key);
    if (local(key).text === undefined) {
      state.baseRev = Math.max(state.baseRev, rev);
    }
    return state;
  };

  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch(logFailure);
  };
  const refuse = (key: K, error: unknown, text = local(key).text) => {
    const state = entry(key);
    clearTimeout(state.saveTimer);
    clearTimeout(state.releaseTimer);
    state.held = false;
    const { draft } = local(key);
    setLocal(key, {
      draft:
        draft ??
        (text === undefined ? undefined : { message: errorText(error), text }),
    });
  };
  // Runs `call` with the block's real id in turn; a tail whose split was
  // refused has none and its calls are dropped.
  const send = (key: K, call: (id: K) => Promise<void>) => {
    enqueue(async () => {
      const id = idOf(key);
      if (id === undefined) {
        return;
      }
      try {
        await call(id);
      } catch (error) {
        refuse(key, error);
      }
    });
  };

  const flush = (key: K) => {
    const state = entry(key);
    clearTimeout(state.saveTimer);
    if (local(key).text === undefined) {
      return;
    }
    send(key, async (blockId) => {
      const { text } = local(key);
      if (text === undefined) {
        return;
      }
      const { rev } = await api.save({ baseRev: state.baseRev, blockId, text });
      state.baseRev = rev;
      if (local(key).text === text) {
        setLocal(key, { ...local(key), text: undefined });
      }
    });
  };

  // The block is gone; nothing it held is left to save or release.
  const forget = (key: K) => {
    const state = entries.get(key);
    clearTimeout(state?.saveTimer);
    clearTimeout(state?.releaseTimer);
    entries.delete(key);
  };

  const release = (key: K) => {
    const state = entry(key);
    clearTimeout(state.releaseTimer);
    if (!state.held) {
      return;
    }
    state.held = false;
    enqueue(async () => {
      const blockId = idOf(key);
      if (blockId !== undefined) {
        await api.stopEdit({ blockId });
      }
    });
  };

  return {
    /** The server's blocks with each split's new block after its head until the server's copy has it; `make` builds that block from its head. */
    blocks: <B extends { _id: K }>(
      server: readonly B[],
      make: (temp: Temp<K>, head: B) => B
    ) => {
      const shown = new Set(server.map((b) => b._id));
      const all = [...server];
      for (const temp of temps) {
        if (temp.id !== undefined && shown.has(temp.id)) {
          shownByServer.add(temp.key);
          continue;
        }
        if (shownByServer.has(temp.key)) {
          continue;
        }
        const at = all.findIndex(
          (b) => (keys.get(b._id) ?? b._id) === temp.afterKey
        );
        const head = all[at];
        if (head) {
          all.splice(at + 1, 0, make(temp, head));
        }
      }
      return all;
    },

    /** Saves, then releases the lease after a grace that focusing again cancels. */
    blur: (key: K) => {
      flush(key);
      const state = entry(key);
      clearTimeout(state.releaseTimer);
      state.releaseTimer = setTimeout(() => {
        release(key);
      }, RELEASE_AFTER_MS);
    },

    /** The person changed the block's content; `rev` is the block's rev as shown. */
    change: (key: K, text: string, rev: number) => {
      const state = startFrom(key, rev);
      setLocal(key, { ...local(key), text });
      clearTimeout(state.releaseTimer);
      const now = Date.now();
      if (!state.held || now - state.takenAt >= RENEW_EVERY_MS) {
        state.held = true;
        state.takenAt = now;
        send(key, async (blockId) => {
          await api.startEdit({ blockId });
        });
      }
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => {
        flush(key);
      }, SAVE_AFTER_MS);
    },

    /** The person set the draft aside. */
    discard: (key: K) => {
      setLocal(key, { ...local(key), draft: undefined });
    },

    /** Sends the block's pending save now, ahead of whatever is queued next. */
    flush,

    focus: (key: K) => {
      clearTimeout(entry(key).releaseTimer);
    },

    /** The tab was hidden: save everything and release. */
    hide: () => {
      for (const key of entries.keys()) {
        flush(key);
        release(key);
      }
    },

    /** The key a block is rendered and edited under. */
    keyOf: (id: K) => keys.get(id) ?? id,

    /** The server granted the person this block's lease along with another write. */
    leased: (key: K) => {
      const state = entry(key);
      state.held = true;
      state.takenAt = Date.now();
    },

    /** The block's local text and draft. The same object until either changes. */
    local,

    /**
     * Sends a write to whole blocks, given as key and rev as shown, after
     * their pending saves. `call` looks up each block's real id and the rev
     * its last write returned, and returns the new revs as key and rev: null
     * for a block the write removed. `shown` stays on the first block until
     * the write lands; when it holds text, the write carries that text in
     * place of the block's pending save. A refusal keeps the first block's
     * unsaved text as a draft, and the promise rejects with it.
     */
    run: async (
      blocks: readonly (readonly [K, number])[],
      call: (
        block: (key: K) => { id: K; rev: number }
      ) => Promise<readonly (readonly [K, number | null])[]>,
      shown: Shown = {}
    ) => {
      const first = blocks[0]?.[0];
      for (const [key, rev] of blocks) {
        const state = startFrom(key, rev);
        if (key === first && shown.text !== undefined) {
          clearTimeout(state.saveTimer);
        } else {
          flush(key);
        }
      }
      if (first !== undefined) {
        setLocal(first, { ...local(first), ...shown });
      }
      const block = (key: K) => {
        const id = idOf(key);
        if (id === undefined) {
          throw new Error(NOT_SAVED);
        }
        return { id, rev: entry(key).baseRev };
      };
      const write = async () => {
        try {
          for (const [key, rev] of await call(block)) {
            if (rev === null) {
              forget(key);
            } else {
              entry(key).baseRev = rev;
            }
          }
        } catch (error) {
          if (first !== undefined) {
            refuse(first, error);
          }
          throw error;
        }
        if (first !== undefined) {
          const now = local(first);
          const landed = <F extends keyof Shown>(field: F) =>
            now[field] === shown[field] ? undefined : now[field];
          setLocal(first, {
            ...now,
            checked: landed("checked"),
            kind: landed("kind"),
            text: landed("text"),
          });
        }
      };
      const done = queue.then(write);
      // The caller hears of a refusal; the queue goes on.
      queue = done.catch(() => null);
      await done;
    },

    /**
     * Splits the block, keeping `headText` in it and putting the rest in a new
     * block after it. Returns the new block's key, which renders and takes
     * typing at once; its writes wait for the split.
     */
    split: (key: K, rev: number, args: SplitArgs) => {
      const head = startFrom(key, rev);
      clearTimeout(head.saveTimer);
      // The split moves the lease to the new block.
      head.held = false;
      const tail = tempKey(realIds.size);
      realIds.set(tail, undefined);
      const tailState = entry(tail);
      tailState.held = true;
      tailState.takenAt = Date.now();
      temps = [
        ...temps,
        {
          afterKey: key,
          checked: args.tailChecked,
          key: tail,
          kind: args.tailKind,
          text: args.tailText,
        },
      ];
      setLocal(key, { ...local(key), text: args.headText });
      enqueue(async () => {
        const blockId = idOf(key);
        try {
          if (blockId === undefined) {
            throw new Error(NOT_SAVED);
          }
          const result = await api.split({
            ...args,
            baseRev: head.baseRev,
            blockId,
          });
          head.baseRev = result.rev;
          tailState.baseRev = result.tailRev;
          realIds.set(tail, result.tailId);
          keys.set(result.tailId, tail);
          temps = temps.map((t) =>
            t.key === tail ? { ...t, id: result.tailId } : t
          );
          if (local(key).text === args.headText) {
            setLocal(key, { ...local(key), text: undefined });
          } else {
            notify();
          }
        } catch (error) {
          temps = temps.filter((t) => t.key !== tail);
          const typed =
            (local(key).text ?? args.headText) +
            (local(tail).text ?? args.tailText);
          clearTimeout(tailState.saveTimer);
          tailState.held = false;
          refuse(key, error, typed);
        }
      });
      return tail;
    },

    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** The temps in flight; a new array whenever one is added, lands or is dropped. */
    temps: () => temps,
  };
};

export type Session<K extends string> = ReturnType<typeof createSession<K>>;
