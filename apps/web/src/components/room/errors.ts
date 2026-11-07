// Convex reports a function's thrown error inside a longer message, e.g.
// "[CONVEX M(messages:send)] [Request ID: …] Server Error\nUncaught Error: The runner is offline …\n    at handler (…)".
// People see only the sentence the backend wrote.
export const errorText = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const uncaught = /Uncaught Error: (?<sentence>.*)/u.exec(message);
  return (uncaught?.groups?.sentence ?? message).trim();
};
