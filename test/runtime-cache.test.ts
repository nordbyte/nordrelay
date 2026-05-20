import { describe, expect, it } from "vitest";

import { RuntimeSnapshotCache } from "../src/runtime/runtime-cache.js";

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

  it("can wait for stale values to refresh on foreground requests", async () => {
    const cache = new RuntimeSnapshotCache();
    let value = 0;
    await expect(cache.get("key", 1, async () => ++value)).resolves.toMatchObject({ value: 1, stale: false });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(cache.get("key", 1, async () => ++value, { staleWhileRefresh: false })).resolves.toMatchObject({
      value: 2,
      stale: false,
    });
  });

  it("warms registered producers without blocking a foreground request", async () => {
    const cache = new RuntimeSnapshotCache();
    let value = 0;
    cache.register("expensive", async () => ++value);

    cache.warm(["expensive"]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(cache.get("expensive", 1000)).resolves.toMatchObject({ value: 1, stale: false });
  });
});
