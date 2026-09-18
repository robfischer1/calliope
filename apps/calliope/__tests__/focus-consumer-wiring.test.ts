// ── the one line that names the real client ──────────────────────────────────
//
// `openFocusConsumer` is `new Consumer(focusConsumerOptions(bootstrap))` and
// nothing else. Mock the package so the constructor's argument is
// inspectable; the module's static import resolves to this mock because
// vi.mock is hoisted above it.

import { describe, expect, it, vi } from "vitest";

const { consumerFactory } = vi.hoisted(() => {
  // A regular function, not an arrow: the module calls `new Consumer(...)`.
  const consumerFactory = vi.fn(function ConsumerMock() {
    return {
      consume: () => Promise.reject(new Error("mock")),
      close: () => Promise.resolve(),
    };
  });
  return { consumerFactory };
});
vi.mock("@platformatic/kafka", () => ({
  Consumer: consumerFactory,
  MessagesStreamModes: { LATEST: "latest" },
  stringDeserializers: { sentinel: "stringDeserializers" },
}));

describe("openFocusConsumer", () => {
  it("builds the client's Consumer from exactly the declared options", async () => {
    const { openFocusConsumer, focusConsumerOptions } =
      await import("../src/focus-register.js");
    consumerFactory.mockClear();
    openFocusConsumer("broker-x:9092");
    expect(consumerFactory).toHaveBeenCalledExactlyOnceWith(
      focusConsumerOptions("broker-x:9092"),
    );
  });

  it("is what startFocusConsumer opens when handed no factory", async () => {
    const { startFocusConsumer, FocusRegister } =
      await import("../src/focus-register.js");
    consumerFactory.mockClear();
    const handle = startFocusConsumer(new FocusRegister(), {
      bootstrap: "broker-y:9092",
      log: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(consumerFactory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ bootstrapBrokers: ["broker-y:9092"] }),
    );
    await handle.stop();
  });
});
