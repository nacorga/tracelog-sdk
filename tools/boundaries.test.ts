import { readFile } from "node:fs/promises";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = process.cwd();

/**
 * A lint rule nothing trips is indistinguishable from one that is switched
 * off, so each rule `eslint.config.mjs` writes is run here over a fixture that
 * breaks it, and over the one file allowed to.
 *
 * One instance for the whole file: constructing ESLint loads the flat config,
 * which is most of what a fixture costs.
 */
let shared: ESLint | undefined;

/** The config load is the slow part, and it happens once, in the first case. */
const LINT_TIMEOUT = 30_000;

async function lintFixture(
  fixture: string,
  filePath: string,
): Promise<readonly ESLint.LintResult["messages"][number][]> {
  const source = await readFile(
    path.join(root, "tools/lint-fixtures", fixture),
    "utf8",
  );
  shared ??= new ESLint({ cwd: root });
  const [result] = await shared.lintText(source, {
    filePath: path.join(root, filePath),
  });
  return result?.messages ?? [];
}

describe("package boundaries", () => {
  /**
   * `capture-core` is what the platform artifacts bind inside sandboxes that
   * have no DOM: a browser global there is a runtime error on Shopify's strict
   * pixel, and lint is where it is caught.
   */
  it(
    "rejects a browser global inside capture-core",
    async () => {
      const messages = await lintFixture(
        "core-browser-global.txt",
        "packages/capture-core/src/browser-global.ts",
      );
      const refused = messages.filter(
        (message) =>
          message.ruleId === "no-restricted-globals" &&
          message.message.includes(
            "capture-core cannot reference browser globals.",
          ),
      );

      expect(refused.map((message) => message.line)).toEqual([1, 2]);
    },
    LINT_TIMEOUT,
  );

  it(
    "lets the browser runtime read the same globals",
    async () => {
      const messages = await lintFixture(
        "core-browser-global.txt",
        "packages/capture-web/src/browser-global.ts",
      );

      expect(
        messages.filter(
          (message) => message.ruleId === "no-restricted-globals",
        ),
      ).toEqual([]);
    },
    LINT_TIMEOUT,
  );

  /**
   * Time is injected, so a test can hold it still. `capture-core` reads no
   * clock at all, and the browser runtime reads the machine's in one file.
   */
  it(
    "rejects reading the machine's clock outside the SDK's own",
    async () => {
      const messages = await lintFixture(
        "machine-clock.txt",
        "packages/capture-core/src/now.ts",
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: "no-restricted-syntax",
            message: expect.stringContaining("injected Clock") as unknown,
          }),
        ]),
      );
    },
    LINT_TIMEOUT,
  );

  it(
    "lets the SDK's clock read it",
    async () => {
      const messages = await lintFixture(
        "machine-clock.txt",
        "packages/capture-web/src/clock.ts",
      );

      expect(
        messages.filter((message) => message.ruleId === "no-restricted-syntax"),
      ).toEqual([]);
    },
    LINT_TIMEOUT,
  );
});

describe("no raw payloads in logs", () => {
  it(
    "rejects logging the event envelope, directly or serialized",
    async () => {
      const messages = await lintFixture(
        "logged-envelope.txt",
        "packages/capture-web/src/logged-envelope.ts",
      );
      const refused = messages.filter(
        (message) =>
          message.ruleId === "no-restricted-syntax" &&
          message.message.includes("envelope never reaches a log"),
      );

      expect(refused.map((message) => message.line)).toEqual([2, 3]);
    },
    LINT_TIMEOUT,
  );
});

describe("test discipline", () => {
  it(
    "rejects a focused, skipped or stubbed vitest test",
    async () => {
      const messages = await lintFixture(
        "focused-test.txt",
        "packages/capture-core/src/consent.test.ts",
      );
      const focused = messages.filter(
        (message) =>
          message.ruleId === "no-restricted-syntax" &&
          message.message.includes("focused"),
      );

      expect(focused.map((message) => message.line)).toEqual([3, 4, 7]);
    },
    LINT_TIMEOUT,
  );

  it(
    "rejects a focused Playwright describe",
    async () => {
      const messages = await lintFixture(
        "focused-playwright-test.txt",
        "examples/reference-nextjs/e2e/browser-floor.spec.ts",
      );

      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: "no-restricted-syntax",
            line: 3,
            message: expect.stringContaining("focused") as unknown,
          }),
        ]),
      );
    },
    LINT_TIMEOUT,
  );
});
