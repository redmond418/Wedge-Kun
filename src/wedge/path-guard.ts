import os from "node:os";
import path from "node:path";

export function assertWedgeUserPathAllowed(targetPath: string, homeDir = os.homedir()): string {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(homeDir);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`Wedge-kun path guard rejected access outside user home: ${resolved}`);
}
