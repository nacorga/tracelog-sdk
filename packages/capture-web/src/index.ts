import {
  createCaptureEngine,
  type AcquisitionContext,
  type CaptureEngine,
  type CaptureRuntime,
  type CaptureStorage,
  type ConversionOptions,
  type InitOptions,
  type TransportResponse,
} from "@tracelog/capture-core";
import { systemClock } from "@tracelog/config";

const WEB_PUBLIC_KEY_PATTERN = /^tl_pk_[a-z2-7]{26}$/;

interface VerificationMode {
  nonce: string;
  opener: Window;
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

let runtime: CaptureRuntime | undefined;
let engine: CaptureEngine | undefined;
let verification: VerificationMode | undefined;
let configValid = false;
let listenersInstalled = false;

function browserStorage(): CaptureStorage {
  try {
    return window.localStorage;
  } catch {
    return new MemoryStorage();
  }
}

function verificationMode(): VerificationMode | undefined {
  const nonce = new URL(window.location.href).searchParams.get("__tl_verify");
  return nonce !== null && nonce.length > 0 && window.opener !== null
    ? { nonce, opener: window.opener }
    : undefined;
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
    ...(verification === undefined ? {} : { mode: "verification" as const }),
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
  if (verification === undefined) return;
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

function init(options: InitOptions): void {
  verification = verificationMode();
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
  reportDiagnostic();
}

const TraceLog = {
  init,
  consent: {
    grant(): void {
      engine?.consent.grant();
      reportDiagnostic();
    },
    deny(): void {
      engine?.consent.deny();
      reportDiagnostic();
    },
    state() {
      return engine?.consent.state() ?? "unknown";
    },
  },
  step(name: string, context?: object): void {
    engine?.step(name, context);
    reportDiagnostic();
  },
  conversion(name: string, options: ConversionOptions): void {
    engine?.conversion(name, options);
    reportDiagnostic();
  },
};

export default TraceLog;
