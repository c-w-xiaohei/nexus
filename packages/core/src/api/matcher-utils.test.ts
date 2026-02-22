import { describe, expect, it } from "vitest";
import { MatcherCombinators } from "./matcher-utils";

type Meta = { role: "admin" | "user"; active: boolean };

const namedMatchers = new Map<string, (identity: Meta) => boolean>([
  ["is-admin", (identity) => identity.role === "admin"],
  ["is-active", (identity) => identity.active],
]);

const resolve = (name: string) => namedMatchers.get(name);

describe("MatcherCombinators", () => {
  it("and() should return true only when all matchers pass", () => {
    const matcher = MatcherCombinators.and<Meta, string>(
      resolve,
      "is-admin",
      "is-active",
    );

    expect(matcher({ role: "admin", active: true })).toBe(true);
    expect(matcher({ role: "admin", active: false })).toBe(false);
    expect(matcher({ role: "user", active: true })).toBe(false);
  });

  it("and() should fail when a named matcher cannot be resolved", () => {
    const matcher = MatcherCombinators.and<Meta, string>(
      resolve,
      "is-admin",
      "missing",
    );

    expect(matcher({ role: "admin", active: true })).toBe(false);
  });

  it("or() should return true when any matcher passes", () => {
    const matcher = MatcherCombinators.or<Meta, string>(
      resolve,
      "is-admin",
      (identity) => identity.active,
    );

    expect(matcher({ role: "admin", active: false })).toBe(true);
    expect(matcher({ role: "user", active: true })).toBe(true);
    expect(matcher({ role: "user", active: false })).toBe(false);
  });

  it("not() should invert matcher result and treat missing named matcher as true", () => {
    const notAdmin = MatcherCombinators.not<Meta, string>(resolve, "is-admin");
    const notMissing = MatcherCombinators.not<Meta, string>(resolve, "missing");

    expect(notAdmin({ role: "admin", active: true })).toBe(false);
    expect(notAdmin({ role: "user", active: true })).toBe(true);
    expect(notMissing({ role: "user", active: false })).toBe(true);
  });
});
