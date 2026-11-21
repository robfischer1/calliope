/** The offline guard: a suite that calls it reaches nothing but loopback. */
import { afterEach, beforeEach } from "vitest";

/** A host a suite may still fetch: its own fixtures and testcontainers. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

const realFetch = globalThis.fetch;

/**
 * Refuses a non-loopback fetch by NAME, so a suite that trips this reads why
 * rather than reporting as a timeout thirty seconds later.
 */
const offlineFetch: typeof globalThis.fetch = (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = "";
  }
  if (hostname !== "" && !isLoopback(hostname)) {
    return Promise.reject(
      new Error(
        `offline guard: this suite tried to fetch ${url} — tests in this ` +
          `package reach nothing but loopback. A live host here means a fake ` +
          `was bypassed (see __tests__/setup/offline.ts).`,
      ),
    );
  }
  return realFetch(input, init);
};

/** Arm the guard for the calling suite. Call once at module scope. */
export function installOfflineGuard(): void {
  beforeEach(() => {
    globalThis.fetch = offlineFetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });
}
