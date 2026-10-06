import {
  createCaptureEngine,
  PRE_CONSENT_CAP,
  type AcquisitionContext,
  type CaptureEngine,
  type CaptureRuntime,
  type CaptureStorage,
  type ConversionOptions,
  type InitOptions,
  type StepOptions,
  type TransportResponse,
} from "@tracelog/capture-core";
import { systemClock } from "./clock.js";
import { createTagSightingPort } from "./tag-sightings.js";

const WEB_PUBLIC_KEY_PATTERN = /^tl_pk_[a-z2-7]{26}$/;
/** The tab's verification nonce, in `sessionStorage`, written at the grant. */
const VERIFICATION_KEY = "__tl.v";

interface VerificationMode {
  nonce: string;
  /** Gone once the tab has been to a page that severed it. */
  opener: Window | null;
}

class MemoryStorage implements CaptureStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/**
 * A platform artifact declares its own verification mode from the platform's
 * test-order signal; a page opened from a verification session still derives
 * it from the opener.
 */
export interface WebInitOptions extends InitOptions {
  mode?: "verification";
}

let declaredMode: "verification" | undefined;
let runtime: CaptureRuntime | undefined;
let engine: CaptureEngine | undefined;
let verification: VerificationMode | undefined;
let configValid = false;
let listenersInstalled = false;
/**
 * Calls made before `init`, made in order once it has run, up to the same 100
 * the engine holds before consent; past that they are dropped
 * ([spec/capture.md] § Consent first).
 */
let early: (() => void)[] = [];

/** True when there is no engine yet, and the call was held, or dropped. */
function heldForInit(call: () => void): boolean {
  if (engine !== undefined) return false;
  if (early.length < PRE_CONSENT_CAP) early.push(call);
  return true;
}

function browserStorage(): CaptureStorage {
  try {
    return window.localStorage;
  } catch {
    return new MemoryStorage();
  }
}

/**
 * A page opened from a verification session carries the marker and has an
 * opener. Once consent is granted there, the tab keeps the nonce, so the mark
 * follows it to the site's next pages and back from a payment taken
 * elsewhere, to the same origin ([spec/capture.md] § Verification mode).
 */
function verificationMode(): VerificationMode | undefined {
  const nonce = new URL(window.location.href).searchParams.get("__tl_verify");
  if (nonce !== null && nonce.length > 0 && window.opener !== null) {
    return { nonce, opener: window.opener };
  }
  let kept: string | null = null;
  try {
    kept = window.sessionStorage.getItem(VERIFICATION_KEY);
  } catch {
    // An unreadable tab storage keeps no mark.
  }
  return kept === null || kept.length === 0
    ? undefined
    : { nonce: kept, opener: window.opener };
}

function keepVerification(keep: boolean): void {
  try {
    if (!keep) window.sessionStorage.removeItem(VERIFICATION_KEY);
    else if (verification !== undefined) {
      window.sessionStorage.setItem(VERIFICATION_KEY, verification.nonce);
    }
  } catch {
    // A tab that cannot keep it marks this page only.
  }
}

function landingPage(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("__tl_verify");
  url.hash = "";
  return url.toString();
}

function utm(): AcquisitionContext["utm"] {
  const search = new URL(window.location.href).searchParams;
  const result: AcquisitionContext["utm"] = {};
  const mappings = [
    ["utm_source", "source"],
    ["utm_medium", "medium"],
    ["utm_campaign", "campaign"],
    ["utm_term", "term"],
    ["utm_content", "content"],
  ] as const;

  for (const [parameter, field] of mappings) {
    const value = search.get(parameter);
    if (value !== null) result[field] = value;
  }
  return result;
}

function device(): AcquisitionContext["device"] {
  const agent = window.navigator.userAgent;
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(agent)) return "tablet";
  if (/Mobi|Android/i.test(agent)) return "mobile";
  return "desktop";
}

function acquisition(): AcquisitionContext {
  const referrer = window.document.referrer;
  return {
    ...(referrer.length === 0 ? {} : { referrer }),
    utm: utm(),
    landingPage: landingPage(),
    device: device(),
    ...(verification === undefined && declaredMode === undefined
      ? {}
      : { mode: "verification" as const }),
  };
}

function isEndpointValid(endpoint: string): boolean {
  try {
    const url = new URL(endpoint, window.location.href);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function reportDiagnostic(): void {
  if (verification === undefined || verification.opener === null) return;
  verification.opener.postMessage(
    {
      type: "tracelog:diag",
      nonce: verification.nonce,
      present: true,
      consent: engine?.consent.state() ?? "unknown",
      configValid,
      drops: runtime?.drops() ?? [],
    },
    "*",
  );
}

async function responseSummary(response: Response): Promise<TransportResponse> {
  if (response.status < 200 || response.status >= 300) {
    return { status: response.status };
  }

  try {
    const body = (await response.json()) as unknown;
    const rejected =
      typeof body === "object" &&
      body !== null &&
      "rejected" in body &&
      Array.isArray(body.rejected)
        ? body.rejected.length
        : 0;
    return rejected === 0
      ? { status: response.status }
      : { status: response.status, rejected };
  } catch {
    return { status: response.status };
  }
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "Unhandled promise rejection";
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  window.addEventListener("error", (event) => {
    runtime?.captureError(event.message || "Unknown error");
    reportDiagnostic();
  });
  window.addEventListener("unhandledrejection", (event) => {
    runtime?.captureError(errorMessage(event.reason));
    reportDiagnostic();
  });
  window.document.addEventListener("visibilitychange", () => {
    if (window.document.visibilityState === "hidden") {
      void runtime?.flush(true).finally(reportDiagnostic);
    }
  });
}

function init(options: WebInitOptions): void {
  verification = verificationMode();
  declaredMode = options.mode;
  const endpoint = options.endpoint ?? "/v1/events";
  configValid =
    WEB_PUBLIC_KEY_PATTERN.test(options.key) && isEndpointValid(endpoint);

  if (runtime === undefined) {
    runtime = createCaptureEngine(
      {
        clock: systemClock,
        storage: browserStorage(),
        transport: {
          async send(request) {
            try {
              const response = await window.fetch(request.endpoint, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${request.key}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(request.batch),
                keepalive: request.keepalive,
              });
              const summary = await responseSummary(response);
              reportDiagnostic();
              return summary;
            } catch (error) {
              reportDiagnostic();
              throw error;
            }
          },
        },
        sightings: createTagSightingPort(),
      },
      acquisition(),
    );
    engine = runtime.engine;
  }

  engine!.init({
    key: configValid ? options.key : "",
    ...(options.endpoint === undefined ? {} : { endpoint }),
  });
  installListeners();
  const held = early;
  early = [];
  for (const call of held) call();
  reportDiagnostic();
}

const TraceLog = {
  init,
  consent: {
    grant(): void {
      if (heldForInit(() => TraceLog.consent.grant())) return;
      engine?.consent.grant();
      if (engine?.consent.state() === "granted") keepVerification(true);
      reportDiagnostic();
    },
    deny(): void {
      if (heldForInit(() => TraceLog.consent.deny())) return;
      engine?.consent.deny();
      keepVerification(false);
      reportDiagnostic();
    },
    state() {
      return engine?.consent.state() ?? "unknown";
    },
  },
  step(name: string, context?: object, options?: StepOptions): void {
    if (heldForInit(() => TraceLog.step(name, context, options))) return;
    engine?.step(name, context, options);
    reportDiagnostic();
  },
  conversion(name: string, options: ConversionOptions): void {
    if (heldForInit(() => TraceLog.conversion(name, options))) return;
    engine?.conversion(name, options);
    reportDiagnostic();
  },
};

export default TraceLog;
