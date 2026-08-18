import { describe, expect, it } from "vitest";

import TraceLog from "./index.js";

describe("capture-web public API", () => {
  it("exposes exactly the documented operations", () => {
    expect(Object.keys(TraceLog)).toEqual([
      "init",
      "consent",
      "step",
      "conversion",
    ]);
    expect(Object.keys(TraceLog.consent)).toEqual(["grant", "deny", "state"]);
    expect(TraceLog.consent.state()).toBe("unknown");
  });
});
