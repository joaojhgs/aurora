import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_SPEECH_READINESS_POLL_MS,
  NATIVE_VOICE_STATUS_POLL_MS,
  startNonOverlappingPoll,
} from "./tauri-app";

afterEach(() => {
  vi.useRealTimers();
});

describe("native state polling", () => {
  it("never overlaps slow native requests and ignores a result after cleanup", async () => {
    vi.useFakeTimers();
    const pending: Array<(value: string) => void> = [];
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          pending.push(resolve);
        }),
    );
    const onValue = vi.fn();

    const stop = startNonOverlappingPoll(load, onValue, 2_000);
    expect(load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);

    pending.shift()?.("first");
    await Promise.resolve();
    await Promise.resolve();
    expect(onValue).toHaveBeenCalledWith("first");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(2);

    stop();
    pending.shift()?.("late");
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onValue).toHaveBeenCalledTimes(1);
  });

  it("keeps the full speech catalog on a slower cadence than voice status", () => {
    expect(NATIVE_VOICE_STATUS_POLL_MS).toBe(2_000);
    expect(NATIVE_SPEECH_READINESS_POLL_MS).toBeGreaterThanOrEqual(30_000);
    expect(NATIVE_SPEECH_READINESS_POLL_MS).toBeGreaterThan(
      NATIVE_VOICE_STATUS_POLL_MS,
    );
  });
});
