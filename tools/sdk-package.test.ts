import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
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

/**
 * The other two published packages. `capture-web` is what a site installs, but
 * the artifacts under `integrations/` bind `capture-core` directly and
 * TraceLog's own ingestion validates against `event-contract`, so all three
 * are somebody else's dependency and all three are opened here.
 */
const LIBRARY_PACKAGES = [
  {
    name: "@tracelog/capture-core",
    directory: "packages/capture-core",
    entry: "dist/index.js",
  },
  {
    name: "@tracelog/event-contract",
    directory: "packages/event-contract",
    entry: "dist/index.js",
  },
] as const;

let consumerRoot = "";
let extracted = "";
const extractedLibraries = new Map<string, string>();

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Packs one workspace package and lays it out where a resolver looks. */
function packInto(name: string, staging: string, into: string): string {
  run("pnpm", ["--filter", name, "pack", "--pack-destination", staging], root);
  const tarball = readdirSync(staging).find((entry) => entry.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error(`No tarball was produced for ${name} in ${staging}`);
  }
  mkdirSync(into, { recursive: true });
  // The tarball's own `package/` prefix is stripped, so the package lands
  // where a resolver looks for it.
  run(
    "tar",
    ["-xzf", path.join(staging, tarball), "-C", into, "--strip-components=1"],
    root,
  );
  return path.join(staging, tarball);
}

beforeAll(() => {
  // Through turbo, so the work is shared with the `build` gate that follows
  // in the same run rather than repeated. The filter's `...` carries
  // capture-core and event-contract, which are packed below.
  run(
    "pnpm",
    ["exec", "turbo", "run", "build", `--filter=${packageName}...`],
    root,
  );

  consumerRoot = mkdtempSync(path.join(tmpdir(), "tracelog-sdk-consumer-"));
  extracted = path.join(consumerRoot, "node_modules", packageName);
  packInto(
    packageName,
    mkdtempSync(path.join(tmpdir(), "tracelog-sdk-pack-")),
    extracted,
  );

  for (const library of LIBRARY_PACKAGES) {
    const into = path.join(consumerRoot, "node_modules", library.name);
    packInto(
      library.name,
      mkdtempSync(path.join(tmpdir(), "tracelog-sdk-pack-")),
      into,
    );
    extractedLibraries.set(library.name, into);
  }

  /**
   * `event-contract` declares one real runtime dependency, and a consumer
   * installs it from the registry. Here the resolved copy is linked in, so
   * importing the extracted package executes the way it would for a stranger
   * rather than failing on a module the tarball never promised to carry.
   */
  const zod = path.dirname(
    createRequire(
      path.join(root, "packages/event-contract/package.json"),
    ).resolve("zod/package.json"),
  );
  symlinkSync(zod, path.join(consumerRoot, "node_modules", "zod"), "dir");
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

  /**
   * `exports` is what a modern resolver reads; `main`, `module` and `types`
   * are what everything older reads, and a manifest carrying only the first
   * is invisible to the second. The three fallbacks have to name the same
   * files, or two resolvers see two packages.
   */
  it("names the same files through `exports` and the legacy fields", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(extracted, "package.json"), "utf8"),
    ) as {
      main?: string;
      module?: string;
      types?: string;
      exports: { ".": { types: string; default: string } };
    };

    expect(manifest.main).toBe(manifest.exports["."].default);
    expect(manifest.module).toBe(manifest.exports["."].default);
    expect(manifest.types).toBe(manifest.exports["."].types);
  });

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

      // The same consumer on the resolver that never reads `exports`: a
      // project still on `moduleResolution: "node"` finds the types through
      // the top-level `types` field or not at all.
      const legacy = path.join(consumerRoot, "node10");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(
        path.join(legacy, "consumer.ts"),
        readFileSync(path.join(consumerRoot, "consumer.ts"), "utf8"),
      );
      writeFileSync(
        path.join(legacy, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              module: "es2020",
              moduleResolution: "node",
              target: "es2020",
              lib: ["ES2020", "DOM"],
              strict: true,
              noEmit: true,
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
          legacy,
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

/**
 * The two packages nobody installs by accident, and everything depends on.
 * `capture-web` is checked above the way a site uses it; these are checked the
 * way the artifacts under `integrations/` and TraceLog's own ingestion use
 * them — resolved by name, imported by a real `node`, and pinned to each
 * other.
 */
describe.each(LIBRARY_PACKAGES)("the published $name tarball", (library) => {
  it("carries its build, its licence and what moving costs", () => {
    const tree = extractedLibraries.get(library.name) ?? "";
    const listed = run(
      "find",
      [".", "-type", "f", "-not", "-path", "./node_modules/*"],
      tree,
    )
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^\.\//u, ""))
      .sort();

    // A published package whose licence is not in the tarball is not
    // readable source to whoever received it, and wordpress.org's GPL
    // compatibility is a claim about what the bundle contains.
    expect(listed).toContain("LICENSE");
    expect(listed).toContain("README.md");
    expect(listed).toContain("CHANGELOG.md");
    expect(listed).toContain("package.json");
    expect(listed).toContain(library.entry);
    expect(listed).toContain(library.entry.replace(/\.js$/u, ".d.ts"));
  });

  it("is published publicly, by its own manifest", () => {
    const tree = extractedLibraries.get(library.name) ?? "";
    const manifest = JSON.parse(
      readFileSync(path.join(tree, "package.json"), "utf8"),
    ) as { publishConfig?: { access?: string }; private?: boolean };

    // The scope is private by default on npm, so a scoped package without
    // this publishes nothing and says it published.
    expect(manifest.publishConfig?.access).toBe("public");
    expect(manifest.private).toBeUndefined();
  });

  it(
    "imports by name, through `exports`, under a real node",
    () => {
      writeFileSync(
        path.join(consumerRoot, `probe-${library.directory.split("/")[1]}.mjs`),
        `const module = await import(${JSON.stringify(library.name)});
if (Object.keys(module).length === 0) {
  throw new Error("the package exported nothing");
}
`,
      );

      expect(() =>
        run(
          "node",
          [`probe-${library.directory.split("/")[1]}.mjs`],
          consumerRoot,
        ),
      ).not.toThrow();
    },
    CONSUMER_TIMEOUT,
  );
});

/**
 * The three publish as one number, and the tarball is where that is provable.
 * pnpm rewrites `workspace:*` to the version it packed, so a release that
 * moved one package and not another leaves `capture-core` depending on an
 * `event-contract` that is either unpublished or a different envelope — and
 * the registry does not take a version back.
 */
it("pins capture-core to the exact event-contract it was built against", () => {
  const core = extractedLibraries.get("@tracelog/capture-core") ?? "";
  const manifest = JSON.parse(
    readFileSync(path.join(core, "package.json"), "utf8"),
  ) as { version: string; dependencies?: Record<string, string> };
  const pinned = manifest.dependencies?.["@tracelog/event-contract"];

  expect(pinned).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(pinned).toBe(manifest.version);
});
