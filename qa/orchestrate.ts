import type { Station } from "./station";

/**
 * docs/fleet-loader-spec.md §6.2 "Connection fan-out: staggered, not simultaneous" — spreads
 * connection attempts over `staggerSeconds` instead of opening them all in one tick, to avoid
 * a connection storm against the CSMS. Each `station.connect()` is fire-and-forget: this loop
 * never awaits one station's connection before scheduling the next, so one station's slow
 * handshake or ONCE-side auth hiccup never delays or blocks any other station (§6.2 "Failure
 * isolation"). `isShuttingDown` is checked at fire time so a shutdown mid-stagger cancels any
 * connection attempts that hadn't fired yet.
 */
export function connectFleet(
  stations: Station[],
  staggerSeconds: number,
  isShuttingDown: () => boolean = () => false,
): void {
  for (const station of stations) {
    const delay = Math.random() * staggerSeconds * 1000;
    setTimeout(() => {
      if (!isShuttingDown()) {
        station.connect();
      }
    }, delay);
  }
}
