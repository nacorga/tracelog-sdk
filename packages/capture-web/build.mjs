import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(packageDirectory, "../..");
const distributionDirectory = path.join(packageDirectory, "dist");
const IIFE_BUDGET_BYTES = 12 * 1024;

function withoutImports(source) {
  return source.replace(/^import\s+[\s\S]*?;\n/gm, "");
}

function withoutExports(source) {
  return source
    .replace(/^export default TraceLog;\n?$/m, "")
    .replace(/\bexport\s+(?=(?:const|function|class)\b)/g, "");
}

/**
 * Each source is an already-emitted file carrying its own `sourceMappingURL`,
 * and the bundle is their concatenation: the maps are not published, and would
 * not describe this file if they were. Left in, the last one wins and every
 * consumer's devtools asks the CDN for a key that was never uploaded.
 */
function withoutSourceMaps(source) {
  return source.replace(/^\/\/# sourceMappingURL=.*$\n?/gm, "");
}

const contractPath = path.join(
  workspaceDirectory,
  "packages/event-contract/dist/index.js",
);
const [clockSource, coreSource, webSource, contract] = await Promise.all([
  readFile(
    path.join(workspaceDirectory, "packages/config/dist/clock.js"),
    "utf8",
  ),
  readFile(
    path.join(workspaceDirectory, "packages/capture-core/dist/index.js"),
    "utf8",
  ),
  readFile(path.join(distributionDirectory, "index.js"), "utf8"),
  import(pathToFileURL(contractPath).href),
]);

const constants = [
  `const EVENT_ENVELOPE_VERSION = ${JSON.stringify(contract.EVENT_ENVELOPE_VERSION)};`,
  `const MAX_BATCH_BYTES = ${JSON.stringify(contract.MAX_BATCH_BYTES)};`,
  `const MAX_BATCH_EVENTS = ${JSON.stringify(contract.MAX_BATCH_EVENTS)};`,
].join("\n");
const runtime = [clockSource, constants, coreSource, webSource]
  .map((source) =>
    withoutExports(withoutImports(withoutSourceMaps(source))).trim(),
  )
  .join("\n");

/**
 * The published surface, written by hand because the bundle inlines its
 * workspace dependencies: a consumer resolves no @tracelog/* package.
 */
const types = `export type ConsentState = "unknown" | "granted" | "denied";

export interface InitOptions {
  key: string;
  endpoint?: string;
  /** Declared by a platform artifact for its platform's test order. */
  mode?: "verification";
}

export interface ConversionOptions {
  identifier: string;
  value?: number;
  currency?: string;
  context?: object;
}

declare const TraceLog: {
  init(options: InitOptions): void;
  consent: { grant(): void; deny(): void; state(): ConsentState };
  step(name: string, context?: object): void;
  conversion(name: string, options: ConversionOptions): void;
};

export default TraceLog;
`;

const esm = `${runtime}\nexport default TraceLog;\n`;
const iife = `(function (global) {\n${runtime}\nglobal.TraceLog = TraceLog;\n})(globalThis);\n`;
const compressedBytes = gzipSync(iife).byteLength;

if (compressedBytes > IIFE_BUDGET_BYTES) {
  throw new Error(
    `capture-web IIFE is ${compressedBytes} bytes gzipped; budget is ${IIFE_BUDGET_BYTES}`,
  );
}

await Promise.all([
  writeFile(path.join(distributionDirectory, "tracelog.d.ts"), types),
  writeFile(path.join(distributionDirectory, "tracelog.esm.js"), esm),
  writeFile(path.join(distributionDirectory, "tracelog.iife.js"), iife),
  writeFile(
    path.join(distributionDirectory, "tracelog.iife.size.json"),
    `${JSON.stringify({ budget: IIFE_BUDGET_BYTES, gzip: compressedBytes })}\n`,
  ),
]);
