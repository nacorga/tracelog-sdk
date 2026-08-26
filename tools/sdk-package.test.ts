import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * The published tarball, opened and used the way a stranger uses it.
 *
 * `@tracelog/capture-web` is the one artifact somebody else installs, and
 * [foundations.md] § Versioning says a published version is never overwritten
 * — the release job refuses before it uploads. So a tarball that does not
 * import, or whose types do not resolve, costs that version number forever,
 * and there is no second chance to notice.
 *
 * Nothing else proves this. The reference application and the integrations
 * consume the package through a workspace link, which resolves `src/` and
 * ignores `files`, `exports` and the hand-written `tracelog.d.ts` entirely —
 * so what every other suite exercises is precisely not what ships.
 *
 * The package is extracted rather than installed: it declares no runtime
 * dependency (the bundle inlines its workspace ones), so a package manager
 * would add a registry round trip and prove nothing extra. Resolution still
 * goes through `exports`, because the extracted tree is laid out under
 * `node_modules/@tracelog/capture-web` and a real `node` resolves it.
 */
const BUILD_AND_PACK_TIMEOUT = 180_000;
const CONSUMER_TIMEOUT = 60_000;

const root = process.cwd();
const packageName = "@tracelog/capture-web";

/** Exactly what `files` promises, plus what npm adds on its own. */
const PUBLISHED_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "dist/tracelog.d.ts",
  "dist/tracelog.esm.js",
  "dist/tracelog.iife.js",
  "package.json",
];

/** The whole surface, and what the major version protects. */
const SURFACE = [
  "init",
  "consent.grant",
  "consent.deny",
  "consent.state",
  "step",
  "conversion",
];

let consumerRoot = "";
let extracted = "";

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeAll(() => {
  // Through turbo, so the work is shared with the `build` gate that follows
  // in the same run rather than repeated.
  run(
    "pnpm",
    ["exec", "turbo", "run", "build", `--filter=${packageName}...`],
    root,
  );

  const staging = mkdtempSync(path.join(tmpdir(), "tracelog-sdk-pack-"));
  run(
    "pnpm",
    ["--filter", packageName, "pack", "--pack-destination", staging],
    root,
  );
  const tarball = readdirSync(staging).find((entry) => entry.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error(`No tarball was produced in ${staging}`);
  }

  consumerRoot = mkdtempSync(path.join(tmpdir(), "tracelog-sdk-consumer-"));
  extracted = path.join(consumerRoot, "node_modules", packageName);
  mkdirSync(extracted, { recursive: true });
  // The tarball's own `package/` prefix is stripped, so the package lands
  // where a resolver looks for it.
  run(
    "tar",
    [
      "-xzf",
      path.join(staging, tarball),
      "-C",
      extracted,
      "--strip-components=1",
    ],
    root,
  );
}, BUILD_AND_PACK_TIMEOUT);

describe("the published capture-web tarball", () => {
  it("carries exactly the files it promises", () => {
    const listed = run(
      "find",
      [".", "-type", "f", "-not", "-path", "./node_modules/*"],
      extracted,
    )
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^\.\//u, ""))
      .sort();

    expect(listed).toEqual(PUBLISHED_FILES);
  });

  it(
    "resolves through `exports` and exposes the whole surface, and nothing more",
    () => {
      const probe = path.join(consumerRoot, "probe.mjs");
      writeFileSync(
        probe,
        `import TraceLog from ${JSON.stringify(packageName)};

const surface = [
  ...Object.keys(TraceLog).filter((key) => key !== "consent"),
  ...Object.keys(TraceLog.consent).map((key) => \`consent.\${key}\`),
];
process.stdout.write(
  JSON.stringify({ surface, stateBeforeInit: TraceLog.consent.state() }),
);
`,
      );

      const reported = JSON.parse(run("node", [probe], consumerRoot)) as {
        surface: string[];
        stateBeforeInit: string;
      };

      expect(reported.surface.sort()).toEqual([...SURFACE].sort());
      // Consent first, read off the published bytes: importing the package
      // and calling nothing builds no engine and claims no state
      // ([spec/capture.md] § Consent first).
      expect(reported.stateBeforeInit).toBe("unknown");
    },
    CONSUMER_TIMEOUT,
  );

  it(
    "defines the same surface on a bare global from the IIFE",
    () => {
      const probe = path.join(consumerRoot, "probe-iife.mjs");
      writeFileSync(
        probe,
        `import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(
  new URL("./node_modules/${packageName}/dist/tracelog.iife.js", import.meta.url),
  "utf8",
);
// The snippet goes in <head>, so at load the script tag form may read only
// globals that exist before the body does. \`TextEncoder\` is the whole list;
// a module-scope \`document\` read would break every page that follows the
// installation instructions, and would fail here.
const context = createContext({ TextEncoder });
runInContext(source, context);

const TraceLog = context.TraceLog;
const surface = [
  ...Object.keys(TraceLog).filter((key) => key !== "consent"),
  ...Object.keys(TraceLog.consent).map((key) => \`consent.\${key}\`),
];
process.stdout.write(
  JSON.stringify({ surface, stateBeforeInit: TraceLog.consent.state() }),
);
`,
      );

      const reported = JSON.parse(run("node", [probe], consumerRoot)) as {
        surface: string[];
        stateBeforeInit: string;
      };

      expect(reported.surface.sort()).toEqual([...SURFACE].sort());
      expect(reported.stateBeforeInit).toBe("unknown");
    },
    CONSUMER_TIMEOUT,
  );

  it(
    "typechecks for a consumer, against the types it publishes",
    () => {
      writeFileSync(
        path.join(consumerRoot, "consumer.ts"),
        `import TraceLog from ${JSON.stringify(packageName)};

TraceLog.init({ key: "tl_pk_aaaaaaaaaaaaaaaaaaaaaaaaaa" });
TraceLog.init({
  key: "tl_pk_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  endpoint: "https://api.tracelog.io/v1/events",
});
TraceLog.consent.grant();
TraceLog.consent.deny();
TraceLog.step("checkout");
TraceLog.step("checkout", { plan: "free" });
TraceLog.conversion("purchase", { identifier: "order-1" });
TraceLog.conversion("purchase", {
  identifier: "order-1",
  value: 12,
  currency: "EUR",
  context: { source: "campaign" },
});

export const state: "unknown" | "granted" | "denied" = TraceLog.consent.state();
`,
      );
      writeFileSync(
        path.join(consumerRoot, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              module: "nodenext",
              moduleResolution: "nodenext",
              target: "es2020",
              lib: ["ES2020", "DOM"],
              strict: true,
              noEmit: true,
              // The consumer's own island: no @types from a parent tree.
              types: [],
            },
            include: ["consumer.ts"],
          },
          null,
          2,
        )}\n`,
      );

      expect(() =>
        run(
          "node",
          [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "."],
          consumerRoot,
        ),
      ).not.toThrow();
    },
    CONSUMER_TIMEOUT,
  );

  it("carries the pinned version into every file that repeats it", () => {
    const config = JSON.parse(
      readFileSync(path.join(root, "release-please-config.json"), "utf8"),
    ) as {
      packages: Record<string, { "extra-files"?: string[] }>;
    };
    const extraFiles =
      config.packages["packages/capture-web"]?.["extra-files"] ?? [];

    // Every surface that prints the version reads it from one generated
    // constant, and release-please has to move that constant in the same
    // commit that bumps the package — otherwise the repository names the
    // previous version until somebody rebuilds, and no gate notices.
    expect(extraFiles.length).toBeGreaterThan(0);

    for (const file of extraFiles) {
      // release-please resolves a leading slash against the repository and
      // everything else against the package. Getting that backwards updates
      // nothing and says nothing, so both halves are resolved here the same
      // way and the file has to be there.
      const resolved = file.startsWith("/")
        ? path.join(root, file.slice(1))
        : path.join(root, "packages/capture-web", file);

      expect(existsSync(resolved), `${file} resolves to ${resolved}`).toBe(
        true,
      );
      expect(readFileSync(resolved, "utf8")).toContain("x-release-please-");
    }
  });

  it("references no source map it does not ship", () => {
    const offenders = ["tracelog.esm.js", "tracelog.iife.js"].filter((file) =>
      run("cat", [path.join("dist", file)], extracted).includes(
        "sourceMappingURL",
      ),
    );

    // The bundles are concatenations of already-emitted files, each of which
    // carried its own `//# sourceMappingURL`. Those maps are not published and
    // would not describe the concatenation if they were: on the CDN they are a
    // 404 every time somebody opens devtools.
    expect(offenders).toEqual([]);
  });
});
