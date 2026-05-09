import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const IdListConfigSchema = z.object({
  channel_ids: z.array(z.string()).optional(),
  user_ids: z.array(z.string()).optional(),
});

export type WedgeConfigIdList = {
  channelIds: Set<string>;
  userIds: Set<string>;
};

export function getWedgeDataDir(): string {
  const configured = process.env.WEDGE_DATA_DIR?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".wedge-kun");
}

export function getWedgeDatabasePath(): string {
  const configured = process.env.WEDGE_DB_PATH?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(getWedgeDataDir(), "wedge.sqlite3");
}

export function readWedgeIdList(filePath: string): WedgeConfigIdList {
  if (!fs.existsSync(filePath)) {
    return { channelIds: new Set(), userIds: new Set() };
  }
  const parsed = IdListConfigSchema.parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
  return {
    channelIds: new Set(parsed.channel_ids ?? []),
    userIds: new Set(parsed.user_ids ?? []),
  };
}

export function readIgnoredChannelIds(repoRoot = process.cwd()): Set<string> {
  return readWedgeIdList(path.join(repoRoot, "config", "ignored_channels.json")).channelIds;
}

export function readAdminUserIds(repoRoot = process.cwd()): Set<string> {
  return readWedgeIdList(path.join(repoRoot, "config", "admin_users.json")).userIds;
}
