import { ConvexError } from "convex/values";

// Convex reports a function's thrown error inside a longer message, e.g.
// "[CONVEX M(messages:send)] [Request ID: …] Server Error\nUncaught Error: The runner is offline …\n    at handler (…)".
// People see only the sentence the backend wrote.
export const errorText = (error: unknown): string => {
  // A refusal that carries data, such as a stale write, puts its sentence there.
  const data: unknown = error instanceof ConvexError ? error.data : null;
  if (
    typeof data === "object" &&
    data !== null &&
    "message" in data &&
    typeof data.message === "string"
  ) {
    return data.message;
  }
  const message = error instanceof Error ? error.message : String(error);
  const uncaught = /Uncaught Error: (?<sentence>.*)/u.exec(message);
  return (uncaught?.groups?.sentence ?? message).trim();
};
