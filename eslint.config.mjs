import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Time is injected. `capture-core` declares the `Clock` port and reads no
 * clock at all, because it runs inside sandboxes that may not have one; the
 * browser runtime implements the port in one file, and that file is the only
 * one allowed to read the machine's.
 */
const clockRule = {
  selector:
    "CallExpression[callee.object.name='Date'][callee.property.name='now']",
  message:
    "Read time through the injected Clock from @tracelog/capture-core; only packages/capture-web/src/clock.ts reads the machine's.",
};
/**
 * No raw payloads in logs. The runtime holds a visitor's conversions — their
 * identifiers, values and context — and a customer's error tracker collects
 * the browser console as breadcrumbs, so a batch logged there leaves the page.
 * These are the names the envelope and its parts travel under, refused
 * anywhere inside a `console` call, however deeply:
 * `console.info(JSON.stringify(payload))` is the same disclosure as
 * `console.info(payload)`.
 */
const envelopeLogRule = {
  selector:
    "CallExpression[callee.object.name='console'] Identifier[name=/^(batch|payload|envelope|rawBody|events)$/]",
  message:
    "The event envelope never reaches a log. Log the scalars that identify it instead.",
};
/**
 * No skipped, disabled or stubbed test stands in for a passing one. A focused
 * test makes the whole suite lie green; a skipped one hides exactly the
 * failure it was written to catch. Both shapes are covered: `it.only(...)` and
 * Playwright's `test.describe.only(...)`.
 */
const focusedTestMessage =
  "A focused, skipped or stubbed test is not a passing one; remove .only/.skip/.todo before the gates.";
const focusedTestRules = [
  {
    selector:
      "CallExpression[callee.object.name=/^(describe|it|test)$/][callee.property.name=/^(only|skip|todo)$/]",
    message: focusedTestMessage,
  },
  {
    selector:
      "CallExpression[callee.object.object.name='test'][callee.object.property.name='describe'][callee.property.name=/^(only|skip)$/]",
    message: focusedTestMessage,
  },
];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/playwright-report/**",
      "**/test-results/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        clockRule,
        envelopeLogRule,
        ...focusedTestRules,
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
      },
    },
  },
  /** The one file allowed to read the machine's clock. */
  {
    files: ["packages/capture-web/src/clock.ts"],
    rules: {
      "no-restricted-syntax": ["error", envelopeLogRule, ...focusedTestRules],
    },
  },
  /**
   * `capture-core` is what the platform artifacts bind inside sandboxes that
   * have no DOM — Shopify's strict pixel is one — so a browser global there is
   * a runtime error on somebody else's checkout, and lint is where it is
   * caught. It extends `tsconfig.sdk.json`, which carries no `dom` lib, so
   * the types refuse it too; this is the message that says why.
   */
  {
    files: ["packages/capture-core/**/*.{ts,js,mjs,cjs}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "window",
          message: "capture-core cannot reference browser globals.",
        },
        {
          name: "document",
          message: "capture-core cannot reference browser globals.",
        },
      ],
    },
  },
];
