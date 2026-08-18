import { readdir, readFile } from "node:fs/promises";

import { createPool } from "@tracelog/db";

const INTEGRATION_SCHEMA = "merge_point_integration";
const MIGRATION_PATTERN = /^\d{12}_[a-z0-9_]+\.sql$/u;
const migrationDirectory = new URL(
  "../../../packages/db/migrations/",
  import.meta.url,
);

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value.trim() === "") {
    throw new Error(
      "DATABASE_URL is required for the capture-to-ingestion integration test.",
    );
  }
  return value;
}

export function integrationDatabaseUrl(): string {
  const url = new URL(databaseUrl());
  url.searchParams.set("options", `-c search_path=${INTEGRATION_SCHEMA}`);
  return url.toString();
}

export async function resetIntegrationDatabase(): Promise<void> {
  const admin = createPool(databaseUrl());
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${INTEGRATION_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${INTEGRATION_SCHEMA}`);
  } finally {
    await admin.end();
  }

  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  const invalidFilenames = filenames.filter(
    (filename) => !MIGRATION_PATTERN.test(filename),
  );
  if (invalidFilenames.length > 0) {
    throw new Error(
      `Migration filenames must match YYYYMMDDHHMM_name.sql: ${invalidFilenames.join(", ")}`,
    );
  }

  const integration = createPool(integrationDatabaseUrl());
  try {
    for (const filename of filenames) {
      await integration.query(
        await readFile(new URL(filename, migrationDirectory), "utf8"),
      );
    }
  } finally {
    await integration.end();
  }
}

export async function dropIntegrationDatabase(): Promise<void> {
  const admin = createPool(databaseUrl());
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${INTEGRATION_SCHEMA} CASCADE`);
  } finally {
    await admin.end();
  }
}
