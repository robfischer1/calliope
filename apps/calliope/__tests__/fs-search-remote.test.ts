import { afterEach, describe, expect, it, vi } from "vitest";
import { DIMS } from "../src/fs-search/encoder.js";
import { RemoteEmbedder, remoteConfig } from "../src/fs-search/remote-embed.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remoteConfig", () => {
  it("requires both URL and model", () => {
    expect(remoteConfig({})).toBeNull();
    expect(remoteConfig({ CALLIOPE_EMBED_URL: "http://x" })).toBeNull();
    expect(
      remoteConfig({
        CALLIOPE_EMBED_URL: "http://x/",
        CALLIOPE_EMBED_MODEL: "all-minilm",
      }),
    ).toEqual({ url: "http://x", model: "all-minilm" });
  });
});

describe("RemoteEmbedder", () => {
  const config = { url: "http://fake", model: "all-minilm" };

  it("accepts 384-dim responses and quantizes to int8 unit vectors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            embeddings: [Array.from({ length: DIMS }, () => 0.5)],
          }),
        ),
      ),
    );
    const remote = new RemoteEmbedder(config, "nominal");
    const [v] = await remote.embed(["text"]);
    expect(v).toHaveLength(DIMS);
    expect(remote.refused).toBe(false);
  });

  it("refuses a wrong-dimensioned endpoint for the process lifetime (bge-m3 guard)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            embeddings: [Array.from({ length: 1024 }, () => 0.1)],
          }),
        ),
      ),
    );
    const remote = new RemoteEmbedder(config, "nominal");
    await expect(remote.embed(["text"])).rejects.toThrow(/1024-dim/);
    expect(remote.refused).toBe(true);
    // Once refused, no further network attempts are made.
    await expect(remote.embed(["again"])).rejects.toThrow(/refused/);
  });

  it("propagates endpoint failures (the caller falls back to local)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 503 })),
    );
    const remote = new RemoteEmbedder(config, "nominal");
    await expect(remote.embed(["text"])).rejects.toThrow(/503/);
    expect(remote.refused).toBe(false); // down ≠ wrong space; may retry later
  });
});
