import { describe, expect, it } from "vitest";

import { RuntimeSnapshotCache } from "../src/runtime-cache.js";

describe("RuntimeSnapshotCache", () => {
  it("returns stale values immediately while refreshing in the background", async () => {
    const cache = new RuntimeSnapshotCache();
    let value = 0;
    await expect(cache.get("key", 1, async () => ++value)).resolves.toMatchObject({ value: 1, stale: false });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const stale = await cache.get("key", 1, async () => ++value);
    expect(stale.value).toBe(1);
    expect(stale.stale).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const fresh = await cache.get("key", 1000, async () => ++value);
    expect(fresh.value).toBe(2);
    expect(fresh.stale).toBe(false);
  });
});
