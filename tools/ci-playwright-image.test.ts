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

async function workflow(name: string): Promise<Workflow> {
  return parse(
    await readFile(
      path.join(repositoryRoot, ".github/workflows", name),
      "utf8",
    ),
  ) as Workflow;
}

async function pinnedPlaywright(): Promise<string> {
  const manifestPath = "examples/reference-nextjs/package.json";
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, manifestPath), "utf8"),
  ) as PackageManifest;
  const version = manifest.devDependencies["@playwright/test"];
  expect(version, `${manifestPath} must pin @playwright/test exactly`).toMatch(
    /^\d+\.\d+\.\d+$/u,
  );
  return version!;
}

it("pins the sdk-e2e container to the Playwright the reference integration depends on", async () => {
  const version = await pinnedPlaywright();
  expect((await workflow("ci.yml")).jobs["sdk-e2e"]?.container?.image).toBe(
    `mcr.microsoft.com/playwright:v${version}-noble`,
  );
});

/** The live reading runs the same suite's browsers, so it moves with the pin. */
it("pins the vendor-reading container to the same Playwright", async () => {
  const version = await pinnedPlaywright();
  expect(
    (await workflow("vendor-reading.yml")).jobs["vendor-reading"]?.container
      ?.image,
  ).toBe(`mcr.microsoft.com/playwright:v${version}-noble`);
});
