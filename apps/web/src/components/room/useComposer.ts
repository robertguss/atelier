import { useState, type KeyboardEvent } from "react";

import { errorText } from "./errors";

/** Draft, busy and error state for a composer. Enter sends; Shift+Enter and IME composition do not. */
export function useComposer(
  send: (body: string, steer: boolean) => Promise<unknown>,
  blocked = false
) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (steer = false) => {
    const body = draft.trim();
    if (!body || busy || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await send(body, steer);
      // Keep anything typed while the send was in flight.
      setDraft((current) => (current.trim() === body ? "" : current));
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void submit();
  };

  return { draft, setDraft, busy, error, submit, onKeyDown };
}
