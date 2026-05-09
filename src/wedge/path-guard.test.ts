import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertWedgeUserPathAllowed } from "./path-guard.js";

describe("assertWedgeUserPathAllowed", () => {
  it("allows paths under the user home", () => {
    const home = os.homedir();
    const target = path.join(home, "wedge-test.txt");
    expect(assertWedgeUserPathAllowed(target, home)).toBe(path.resolve(target));
  });

  it("rejects paths outside the user home", () => {
    expect(() => assertWedgeUserPathAllowed("C:\\Windows\\System32", "C:\\Users\\redmo")).toThrow(
      /outside user home/,
    );
  });
});
