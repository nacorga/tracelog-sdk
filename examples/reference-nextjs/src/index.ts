import TraceLog from "@tracelog/capture-web";

type CaptureRuntime = typeof TraceLog;

export function initializeReferenceApp(
  options: { key: string; endpoint?: string },
  runtime: CaptureRuntime = TraceLog,
): void {
  runtime.init(options);
}

export function runDeclaredCheckoutPath(
  identifier: string,
  runtime: CaptureRuntime = TraceLog,
): void {
  runtime.step("checkout_started", { cartItems: 2 });
  runtime.conversion("purchase_completed", {
    identifier,
    value: 99.95,
    currency: "EUR",
    context: { checkoutVersion: "v2" },
  });
}
