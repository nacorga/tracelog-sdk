import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import {
  createApi,
  type IngestionDependencies,
  type VerificationApiDependencies,
} from "@tracelog/api";
import type {
  EvaluationInput,
  EvaluatorEvent,
  PreviousConversionState,
  ProjectEvaluation,
} from "@tracelog/detectors";
import type {
  CreateVerificationLinkRecord,
  VerificationLinkRecord,
  VerificationRepositoryPort,
  VersionedPlan,
} from "@tracelog/domain";
import {
  InMemoryIngestionStore,
  type InMemoryProjectSnapshot,
} from "@tracelog/platform-testkit";

/**
 * The generic channel: the pre-filled script tag of the verification session,
 * on a bare HTML page that is nothing but the snippet, reaching `verified`
 * through the same evaluator the installation surface reads.
 */
const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const captureDirectory = path.resolve(
  packageDirectory,
  "../../packages/capture-web",
);
const [iifeSource, capturePackage] = await Promise.all([
  readFile(path.join(captureDirectory, "dist/tracelog.iife.js"), "utf8"),
  readFile(path.join(captureDirectory, "package.json"), "utf8").then(
    (value) => JSON.parse(value) as { version: string },
  ),
]);

const projectId = "generic-project";
const publicKey = `tl_pk_${"a".repeat(26)}`;
const clock = { now: () => new Date() };
const ingestionStore = new InMemoryIngestionStore([]);
let baseUrl = "";

/** The snippet exactly as the verification session hands it over. */
function snippetFor(endpoint: string): string {
  return `<script src="https://cdn.tracelog.io/v/${capturePackage.version}/tracelog.js"></script>
<script>
  TraceLog.init({ key: ${JSON.stringify(publicKey)}, endpoint: ${JSON.stringify(endpoint)} });
  // Keep capture behind consent; call TraceLog.consent.grant() only after consent is granted.
</script>`;
}

const plan: VersionedPlan = {
  id: "generic-plan",
  projectId,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  conversions: [
    {
      type: "purchase",
      eventName: "purchase_completed",
      identifierLabel: "order number",
      expectsValue: true,
      currency: "EUR",
      isPrimary: true,
      steps: ["checkout_started"],
    },
  ],
};

function payload(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function evaluatorEvents(
  snapshot: InMemoryProjectSnapshot,
): readonly EvaluatorEvent[] {
  return snapshot.rawEvents.map(({ event }) => {
    const value = payload(event.payload);
    return {
      projectId,
      eventId: event.eventId,
      sessionId: event.sessionId,
      name: event.name,
      kind: event.kind,
      occurredAt: event.occurredAt,
      ...(event.mode === undefined ? {} : { mode: event.mode }),
      ...(typeof value.identifier === "string"
        ? { identifier: value.identifier }
        : {}),
      ...(typeof value.value === "number" ? { value: value.value } : {}),
      ...(typeof value.currency === "string"
        ? { currency: value.currency }
        : {}),
      ...(value.device === "desktop" ||
      value.device === "mobile" ||
      value.device === "tablet"
        ? { device: value.device }
        : {}),
    };
  });
}

class MemoryEvaluationStore {
  #previous: PreviousConversionState[] = [];

  async loadVerificationInput(): Promise<EvaluationInput> {
    return {
      projectId,
      timezone: "UTC",
      plans: [plan],
      events: evaluatorEvents(ingestionStore.snapshot(projectId)),
      rejectedConversions: [],
      previousStates: this.#previous,
    };
  }

  async saveEvaluation(result: ProjectEvaluation): Promise<void> {
    this.#previous = result.conversions.map((conversion) => ({
      planVersion: conversion.planVersion,
      conversionEventName: conversion.conversionEventName,
      state: conversion.state,
      provenance: conversion.provenance,
      since: conversion.since,
    }));
  }
}

class MemoryVerificationRepository implements VerificationRepositoryPort {
  async canAccessProject(): Promise<boolean> {
    return true;
  }
  async readProjectContext(requested: string) {
    return requested === projectId
      ? {
          id: projectId,
          organizationId: "org-a",
          name: "Bare shop",
          timezone: "UTC",
          publicKey,
          siteUrl: `${baseUrl}/shop`,
          channel: "script" as const,
        }
      : null;
  }
  async createLink(
    input: CreateVerificationLinkRecord,
  ): Promise<VerificationLinkRecord> {
    return {
      id: input.id,
      projectId: input.projectId,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt.toISOString(),
      revokedAt: null,
      recipientEmail: input.recipientEmail,
    };
  }
  async resolveLink(): Promise<VerificationLinkRecord | null> {
    return null;
  }
  async listLinks() {
    return [];
  }
  async revokeLink() {
    return false;
  }
}

const ingestion: IngestionDependencies = {
  clock,
  metadata: {
    resolveKey: async (key) =>
      key === publicKey
        ? {
            projectId,
            kind: "public",
            originAllowlist: [baseUrl],
            stagingHostnames: [],
            internalIpCidrs: [],
          }
        : null,
  },
  store: ingestionStore,
  country: { countryCode: () => "ES" },
};
const verification: VerificationApiDependencies = {
  clock,
  get channels() {
    return {
      eventsEndpoint: `${baseUrl}/v1/events`,
      serverEventsEndpoint: `${baseUrl}/v1/server/events`,
      assistantEndpoint: `${baseUrl}/v1/assistant/mcp`,
      auditConfirmEndpoint: `${baseUrl}/v1/audit/confirm`,
      appUrl: baseUrl,
      siteUrl: "https://tracelog.io",
    };
  },
  sessions: {
    session: async () => ({ userId: "user-a", email: "owner@example.com" }),
  },
  repository: new MemoryVerificationRepository(),
  evaluations: new MemoryEvaluationStore(),
  /** No link is sent here; the port exists so the composition is whole. */
  delivery: { send: async () => ({ id: "unsent" }) },
};
const api = createApi(ingestion, undefined, verification);

api.get("/tracelog.js", async (_request, reply) =>
  reply.type("text/javascript").send(iifeSource),
);
api.get("/shop", async (_request, reply) =>
  reply.type("text/html").send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Bare shop</title></head>
  <body>
    <h1>Bare shop</h1>
    ${snippetFor(`${baseUrl}/v1/events`).replace(
      `https://cdn.tracelog.io/v/${capturePackage.version}/tracelog.js`,
      "/tracelog.js",
    )}
    <script>
      TraceLog.consent.grant();
      TraceLog.step("checkout_started");
      TraceLog.conversion("purchase_completed", {
        identifier: "order-777",
        value: 99.95,
        currency: "EUR"
      });
    </script>
  </body>
</html>`),
);

test.beforeAll(async () => {
  baseUrl = await api.listen({ host: "127.0.0.1", port: 0 });
});

test.afterAll(async () => {
  await api.close();
});

test("a bare page carrying the snippet reaches verified", async ({
  page,
  request,
}) => {
  const snippet = snippetFor(`${baseUrl}/v1/events`);
  expect(snippet).toContain("https://cdn.tracelog.io/v/");
  expect(snippet).toContain(`endpoint: "${baseUrl}/v1/events"`);
  expect(snippet).not.toContain("latest");

  await page.goto(`${baseUrl}/shop`);
  await page.waitForRequest(
    (value) => new URL(value.url()).pathname === "/v1/events",
    { timeout: 20_000 },
  );

  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${baseUrl}/v1/projects/${projectId}/verification`,
        );
        return ((await response.json()) as { state: string }).state;
      },
      { timeout: 20_000 },
    )
    .toBe("verified");

  const snapshot = ingestionStore.snapshot(projectId);
  expect(snapshot.conversions).toEqual([
    {
      projectId,
      name: "purchase_completed",
      identifier: "order-777",
      firstBrowserAt: expect.any(String),
      firstServerAt: null,
      /** The session the browser evidence belonged to, which attributes it. */
      browserSessionId: expect.any(String),
      /**
       * The class of the first evidence, whatever it is: the engines this
       * suite runs on do not agree about whether a headless browser looks
       * like a robot, and the identity is not what that decides.
       */
      trafficClass: expect.any(String),
    },
  ]);
});
