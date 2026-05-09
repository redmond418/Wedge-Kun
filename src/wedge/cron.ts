import cron from "node-cron";
import { openWedgeDatabase } from "./storage.js";

export function runWedgeMemoryRecovery() {
  const db = openWedgeDatabase();
  try {
    return db.runMemoryBatch();
  } finally {
    db.close();
  }
}

export function startWedgeDailyMemoryBatch() {
  try {
    runWedgeMemoryRecovery();
  } catch (err) {
    console.warn("[wedge] memory recovery skipped:", err);
  }
  return cron.schedule("0 4 * * *", () => {
    try {
      runWedgeMemoryRecovery();
    } catch (err) {
      console.warn("[wedge] memory batch failed:", err);
    }
  });
}
