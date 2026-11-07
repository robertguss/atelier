import { describe, expect, it } from "vitest";

import { withEnvValue } from "./rotate-secret.ts";

describe(withEnvValue, () => {
  it("replaces the key in place and keeps every other line", () => {
    const text =
      "CONVEX_URL=https://x\nATELIER_RUNNER_SECRET=old\nATELIER_RUNNER_NAME=box\n";
    expect(withEnvValue(text, "ATELIER_RUNNER_SECRET", "new")).toBe(
      "CONVEX_URL=https://x\nATELIER_RUNNER_SECRET=new\nATELIER_RUNNER_NAME=box\n"
    );
  });

  it("replaces an exported key and leaves keys that only share a prefix", () => {
    const text =
      "ATELIER_RUNNER_SECRET_OLD=keep\nexport ATELIER_RUNNER_SECRET=old\n";
    expect(withEnvValue(text, "ATELIER_RUNNER_SECRET", "new")).toBe(
      "ATELIER_RUNNER_SECRET_OLD=keep\nATELIER_RUNNER_SECRET=new\n"
    );
  });

  it("adds the key when the file lacks it or is empty", () => {
    expect(
      withEnvValue("CONVEX_URL=https://x\n", "ATELIER_RUNNER_SECRET", "new")
    ).toBe("CONVEX_URL=https://x\nATELIER_RUNNER_SECRET=new\n");
    expect(
      withEnvValue("CONVEX_URL=https://x", "ATELIER_RUNNER_SECRET", "new")
    ).toBe("CONVEX_URL=https://x\nATELIER_RUNNER_SECRET=new\n");
    expect(withEnvValue("", "ATELIER_RUNNER_SECRET", "new")).toBe(
      "ATELIER_RUNNER_SECRET=new\n"
    );
  });
});
