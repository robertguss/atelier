import { useState } from "react";
import type { KeyboardEvent } from "react";

import { errorText } from "./errors";

/** Draft, busy and error state for a composer. Enter sends; Shift+Enter and IME composition do not. */
export const useComposer = (
  send: (body: string, steer: boolean) => Promise<unknown>,
  blocked = false
) => {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendDraft = async (steer: boolean) => {
    const body = draft.trim();
    if (!body || busy || blocked) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await send(body, steer);
      // Keep anything typed while the send was in flight.
      setDraft((current) => (current.trim() === body ? "" : current));
    } catch (error_) {
      setError(errorText(error_));
    }
    setBusy(false);
  };

  // Sending reports its own failures; the catch covers anything unexpected.
  const submit = (steer = false) => {
    sendDraft(steer).catch((error_: unknown) => {
      setError(errorText(error_));
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) {
      return;
    }
    e.preventDefault();
    submit();
  };

  return { busy, draft, error, onKeyDown, setDraft, submit };
};
