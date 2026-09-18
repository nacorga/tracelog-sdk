import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The browser floor runs inside the official Playwright image, which carries
 * the browsers already built. Playwright refuses a browser build it did not
 * ship with, so the image tag and the dependency are one pin in two files —
 * and a pin in two files drifts unless something compares them.
 */
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

interface Workflow {
  readonly jobs: Record<string, { readonly container?: { image?: string } }>;
}

interface PackageManifest {
  readonly devDependencies: Record<string, string>;
}

it("pins the sdk-e2e container to the Playwright the reference integration depends on", async () => {
  const workflow = parse(
    await readFile(
      path.join(repositoryRoot, ".github/workflows/ci.yml"),
      "utf8",
    ),
  ) as Workflow;
  const manifestPath = "examples/reference-nextjs/package.json";
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, manifestPath), "utf8"),
  ) as PackageManifest;

  const version = manifest.devDependencies["@playwright/test"];
  expect(version, `${manifestPath} must pin @playwright/test exactly`).toMatch(
    /^\d+\.\d+\.\d+$/u,
  );
  expect(workflow.jobs["sdk-e2e"]?.container?.image).toBe(
    `mcr.microsoft.com/playwright:v${version}-noble`,
  );
});
