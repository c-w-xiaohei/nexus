import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createEvtChannel } from "./evt-channel";

describe("EvtChannel", () => {
  it("delivers synchronously and cancels repeated callbacks independently", () => {
    const [changedChanel, controller] = createEvtChannel<number>();
    const listener = vi.fn();
    const stop = changedChanel(listener);
    changedChanel(listener);
    expect(controller.safeEmit(1).isOk()).toBe(true);
    expect(listener.mock.calls).toEqual([[1], [1]]);
    stop();
    stop();
    controller.safeEmit(2);
    expect(listener.mock.calls).toEqual([[1], [1], [2]]);
    expectTypeOf(controller.safeEmit).parameter(0).toEqualTypeOf<number>();
    expectTypeOf(changedChanel).not.toHaveProperty("safeEmit");
    expectTypeOf(changedChanel).not.toHaveProperty("clear");
    expectTypeOf(controller).not.toHaveProperty("subscribe");
    expectTypeOf(changedChanel)
      .parameter(0)
      .toEqualTypeOf<(value: number) => void>();
  });

  it("skips cancelled listeners and defers newly added listeners", () => {
    const [changedChanel, controller] = createEvtChannel<number>();
    const calls: string[] = [];
    let stopSecond = () => {};
    changedChanel((value) => {
      calls.push(`first:${value}`);
      stopSecond();
      if (value === 1) changedChanel((next) => calls.push(`new:${next}`));
    });
    stopSecond = changedChanel((value) => calls.push(`second:${value}`));
    controller.safeEmit(1);
    controller.safeEmit(2);
    expect(calls).toEqual(["first:1", "first:2", "new:2"]);
  });

  it("returns thrown failures in order without skipping later listeners", () => {
    const [changedChanel, controller] = createEvtChannel<number>();
    const first = { code: "observer-failed" };
    const second = new Error("another failure");
    const later = vi.fn();
    changedChanel(() => {
      throw first;
    });
    changedChanel(() => {
      throw second;
    });
    changedChanel(later);
    const result = controller.safeEmit(1);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual([first, second]);
      expect(result.error[0]).toBe(first);
      expect(result.error[1]).toBe(second);
    }
    expect(later).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("clear invalidates in-flight listeners and allows a fresh subscription", () => {
    const [changedChanel, controller] = createEvtChannel<number>();
    const calls: string[] = [];
    changedChanel(() => {
      calls.push("old:first");
      controller.clear();
      changedChanel((value) => calls.push(`new:${value}`));
      controller.safeEmit(2);
    });
    const stopOld = changedChanel(() => calls.push("old:second"));
    expect(controller.safeEmit(1).isOk()).toBe(true);
    stopOld();
    controller.safeEmit(3);
    expect(calls).toEqual(["old:first", "new:2", "new:3"]);
  });

  it("keeps nested emissions synchronous and leaves their results to their callers", () => {
    const [changedChanel, controller] = createEvtChannel<number>();
    const calls: string[] = [];
    changedChanel((value) => {
      calls.push(`first:${value}`);
      if (value === 1) expect(controller.safeEmit(2).isErr()).toBe(true);
    });
    changedChanel((value) => {
      calls.push(`second:${value}`);
      if (value === 2) throw new Error("nested");
    });
    expect(controller.safeEmit(1).isOk()).toBe(true);
    expect(calls).toEqual(["first:1", "first:2", "second:2", "second:1"]);
  });
});
