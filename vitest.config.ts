import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const isRepositoryRoot = process.cwd() === repositoryRoot;

/**
 * One config for every suite, switched on where it runs: at the root it runs
 * the repository's own tests under `tools/`, inside a package that package's
 * `src/`. Tests live beside the code they prove.
 */
export default defineConfig({
  test: {
    include: isRepositoryRoot ? ["tools/**/*.test.ts"] : ["src/**/*.test.ts"],
  },
});
