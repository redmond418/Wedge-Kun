import { describe, expect, it } from "vitest";
import { parseWedgeAdminCommand } from "./admin.js";

describe("parseWedgeAdminCommand", () => {
  it("parses sleep", () => {
    expect(parseWedgeAdminCommand("!wedge_sleep 5")).toEqual({ kind: "sleep", minutes: 5 });
  });

  it("parses reset", () => {
    expect(parseWedgeAdminCommand("!wedge_reset")).toEqual({ kind: "reset" });
  });

  it("ignores unrelated commands", () => {
    expect(parseWedgeAdminCommand("!wedge_sleep nope")).toBeUndefined();
  });
});
