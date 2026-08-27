import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { resolveStaggerSeconds } from "./config";

describe("resolveStaggerSeconds", () => {
  const originalOverride = process.env.STAGGER_SECONDS;

  afterEach(() => {
    if (originalOverride === undefined) {
      process.env.STAGGER_SECONDS = undefined;
      // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
      delete process.env.STAGGER_SECONDS;
    } else {
      process.env.STAGGER_SECONDS = originalOverride;
    }
  });

  test("uses STAGGER_SECONDS when set, regardless of fleet size", () => {
    process.env.STAGGER_SECONDS = "42";
    assert.equal(resolveStaggerSeconds(5000), 42);
  });

  test("floors at 10s for a small fleet", () => {
    // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
    delete process.env.STAGGER_SECONDS;
    assert.equal(resolveStaggerSeconds(5), 10);
  });

  test("scales at roughly 9%/s for a larger fleet", () => {
    // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
    delete process.env.STAGGER_SECONDS;
    assert.equal(resolveStaggerSeconds(1000), 90);
  });
});
