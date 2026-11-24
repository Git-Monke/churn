import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import type { AuthUser } from "./auth.js";

/** No 0/O, 1/I/L: easy to read off a TV and type on a phone. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
/** Jellyfin's own Quick Connect codes last about this long. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** Pairings waiting at once, across every device; more are refused. */
const MAX_PENDING = 50;

export type PairingStatus = "pending" | "approved" | "denied";

/**
 * One device asking to be paired. The device holds `pollToken`; whoever
 * approves only needs `code`. Kept in memory: a pairing that outlives a
 * server restart is simply started again.
 */
export interface Pairing {
  code: string;
  /** sha256 of the token the device polls with. */
  pollTokenHash: string;
  deviceName: string;
  /** The Jellyfin device id the paired session will use. */
  deviceId: string;
  /** Jellyfin Quick Connect: the code to authorize and the secret to redeem. */
  quickConnectCode: string;
  quickConnectSecret: string;
  createdAt: number;
  expiresAt: number;
  status: PairingStatus;
  /** Set on approval; handed to the device once, then the pairing is gone. */
  issued?: { token: string; user: AuthUser; expiresAt: number };
}

export interface PairingStore {
  /** Returns undefined when too many pairings are already waiting. */
  create(input: {
    deviceName: string;
    deviceId: string;
    quickConnectCode: string;
    quickConnectSecret: string;
  }): { pairing: Pairing; pollToken: string } | undefined;
  /** A pairing that hasn't expired, by its code (case-insensitive). */
  get(code: string): Pairing | undefined;
  /** The pairing, if the poll token matches it. */
  getForDevice(code: string, pollToken: string): Pairing | undefined;
  delete(code: string): void;
}

export function createPairingStore(options: { now?: () => number; ttlMs?: number } = {}): PairingStore {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PAIRING_TTL_MS;
  const pairings = new Map<string, Pairing>();

  function sweep(): void {
    const currentTime = now();
    for (const [code, pairing] of pairings) {
      if (pairing.expiresAt <= currentTime) pairings.delete(code);
    }
  }

  function get(code: string): Pairing | undefined {
    sweep();
    return pairings.get(normalizeCode(code));
  }

  return {
    create(input) {
      sweep();
      if (pairings.size >= MAX_PENDING) return undefined;
      let code = generatePairingCode();
      while (pairings.has(code)) code = generatePairingCode();
      const pollToken = randomBytes(32).toString("base64url");
      const createdAt = now();
      const pairing: Pairing = {
        code,
        pollTokenHash: hash(pollToken),
        ...input,
        createdAt,
        expiresAt: createdAt + ttlMs,
        status: "pending",
      };
      pairings.set(code, pairing);
      return { pairing, pollToken };
    },
    get,
    getForDevice(code, pollToken) {
      const pairing = get(code);
      if (!pairing) return undefined;
      const expected = Buffer.from(pairing.pollTokenHash, "hex");
      const actual = Buffer.from(hash(pollToken), "hex");
      return expected.length === actual.length && timingSafeEqual(expected, actual) ? pairing : undefined;
    },
    delete(code) {
      pairings.delete(normalizeCode(code));
    },
  };
}

export function generatePairingCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

/** Accept what a person types: lower case, spaces and dashes are fine. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

export function isPairingCode(code: string): boolean {
  return new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(normalizeCode(code));
}

/**
 * A device's name, made safe to show and to pass to Jellyfin (it goes inside a
 * quoted header): printable characters only, no quotes, at most 60.
 */
export function cleanDeviceName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/["\\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
