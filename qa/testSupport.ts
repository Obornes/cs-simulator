import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test-only helper (not a *.test.ts file, so `npm run test`'s glob skips it as a suite).

export async function withTempFile(
  content: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "qa-test-"));
  const path = join(dir, "file.json");
  try {
    await writeFile(path, content);
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function withTempJsonFile(
  content: unknown,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  await withTempFile(JSON.stringify(content), fn);
}
