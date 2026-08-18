import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(packageDirectory, "dist/index.js");
const source = await readFile(outputPath, "utf8");

await writeFile(
  path.join(packageDirectory, "dist/reference-app.js"),
  source.replace('from "@tracelog/capture-web"', 'from "/tracelog.esm.js"'),
);
