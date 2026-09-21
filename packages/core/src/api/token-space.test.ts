import { describe, expect, it } from "vitest";
import { number, object } from "valibot";
import { TokenSpace } from "./token-space";

type Model = {
  contextMeta: object;
  connectionMeta: object;
  connectionTarget: { id: string };
};

describe("TokenSpace", () => {
  it("builds qualified service names through child namespaces", () => {
    const app = new TokenSpace<Model>({ name: "app" });
    const service = app.space("services").token<{ read(): string }>("catalog");

    expect(app.name).toBe("app");
    expect(app.fullPath).toBe("app");
    expect(service.id).toBe("app:services:catalog");
  });

  it("creates validated State tokens without selecting a connection", () => {
    const validation = { state: object({ count: number() }) };
    const token = new TokenSpace<Model>({ name: "app" })
      .space("state")
      .storeToken<{ count: number }>("counter", { validation });

    expect(token.id).toBe("app:state:counter");
    expect(token.validation).toBe(validation);
  });

  it("rejects empty or ambiguous namespace and token names", () => {
    expect(() => new TokenSpace<Model>({ name: "" })).toThrow();
    expect(() => new TokenSpace<Model>({ name: "app:invalid" })).toThrow();

    const app = new TokenSpace<Model>({ name: "app" });
    expect(() => app.token("" as never)).toThrow();
    expect(() => app.space("invalid:name")).toThrow();
  });
});
