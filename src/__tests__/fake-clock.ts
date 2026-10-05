// The suites that drive a real ACP child keep the bridge's timers on a fake
// clock. The child is another process and runs in real time, so the clock also
// runs at real speed unless a test stands it still, and a test reaches one of
// the bridge's limits (a watchdog, the restart hold, the idle timeout) by
// moving the clock past it rather than by waiting for it.

import { vi } from "vitest";

// Taken when this module loads, before any test installs the fake clock, so
// a wait for the child runs in real time and never moves the fake one.
const realSetTimeout = globalThis.setTimeout;

/** The timers the bridge reads. The child's I/O runs on none of them. */
const BRIDGE_TIMERS: ("setTimeout" | "clearTimeout" | "setInterval" | "clearInterval" | "Date")[] = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
];

/** A fake clock running at real speed until a test moves it. */
export function useBridgeClock(): void {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: BRIDGE_TIMERS });
}

/** A fake clock standing still until a test moves it. */
export function freezeBridgeClock(): void {
  vi.useFakeTimers({ toFake: BRIDGE_TIMERS });
}

/**
 * Wait for something a child process does: `check` is asked again every
 * 10 ms of real time until it stops throwing, for as long as a loaded machine
 * takes to spawn a child. Unlike vi.waitFor it leaves the fake clock where it
 * is, which a test on a clock standing still depends on.
 */
export async function untilChild(check: () => void | Promise<void>, timeoutMs = 8_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (performance.now() > deadline) throw err;
    }
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
}
