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
  runtime.step(
    "checkout_started",
    { cartItems: 2 },
    {
      items: [
        { id: "sku-shirt", name: "Linen shirt", quantity: 1, price: 59.95 },
      ],
    },
  );
  runtime.conversion("purchase_completed", {
    identifier,
    value: 99.95,
    currency: "EUR",
    context: { checkoutVersion: "v2" },
    items: [
      { id: "sku-shirt", name: "Linen shirt", quantity: 1, price: 59.95 },
      {
        id: "sku-scarf",
        name: "Wool scarf",
        category: "Accessories",
        quantity: 1,
        price: 40,
      },
    ],
    recurring: false,
  });
}
