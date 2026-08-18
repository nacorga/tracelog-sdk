import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  consent: { grant: vi.fn(), deny: vi.fn(), state: vi.fn(() => "unknown") },
  step: vi.fn(),
  conversion: vi.fn(),
}));

vi.mock("@tracelog/capture-web", () => ({ default: sdk }));

import { initializeReferenceApp, runDeclaredCheckoutPath } from "./index.js";

describe("reference integration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("drives the declared checkout path through only the public SDK", () => {
    initializeReferenceApp({
      key: `tl_pk_${"a".repeat(26)}`,
      endpoint: "/v1/events",
    });
    runDeclaredCheckoutPath("order_123");

    expect(sdk.init).toHaveBeenCalledOnce();
    expect(sdk.step).toHaveBeenCalledWith("checkout_started", { cartItems: 2 });
    expect(sdk.conversion).toHaveBeenCalledWith("purchase_completed", {
      identifier: "order_123",
      value: 99.95,
      currency: "EUR",
      context: { checkoutVersion: "v2" },
    });
  });
});
