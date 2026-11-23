import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PasskeyRecord {
  id: string;
  origin: string;
  publicKey: string;
  counter: number;
  userId: string;
  profileId?: string;
  accessToken: string;
  deviceId: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

function isPasskey(value: unknown): value is PasskeyRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["id", "origin", "publicKey", "userId", "accessToken", "deviceId", "label", "createdAt"]
    .every((key) => typeof record[key] === "string" && record[key] !== "") &&
    Number.isSafeInteger(record.counter) && Number(record.counter) >= 0 &&
    (record.profileId === undefined || typeof record.profileId === "string") &&
    (record.lastUsedAt === undefined || typeof record.lastUsedAt === "string");
}

/** Each credential owns its own Jellyfin device token. Persist updates before minting a session. */
export function createPasskeyStore(stateDir: string) {
  const file = path.join(stateDir, "passkeys.json");
  let records = new Map<string, PasskeyRecord>();
  try {
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(saved) || !saved.every(isPasskey)) {
      throw new Error("Invalid Churn passkey store");
    }
    records = new Map(saved.map((record) => [record.id, record]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  function persist(next: Map<string, PasskeyRecord>) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify([...next.values()]), { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    records = next;
  }

  return {
    get: (id: string) => records.get(id),
    list: (userId: string) => [...records.values()].filter((record) => record.userId === userId),
    add(record: PasskeyRecord) {
      if (records.has(record.id)) return false;
      persist(new Map(records).set(record.id, record));
      return true;
    },
    update(expected: PasskeyRecord, counter: number) {
      if (records.get(expected.id) !== expected) return false;
      persist(new Map(records).set(expected.id, {
        ...expected, counter, lastUsedAt: new Date().toISOString(),
      }));
      return true;
    },
    remove(removed: PasskeyRecord[]) {
      if (removed.length === 0) return;
      const next = new Map(records);
      for (const record of removed) next.delete(record.id);
      persist(next);
    },
  };
}

export type PasskeyStore = ReturnType<typeof createPasskeyStore>;
