import dns from "node:dns/promises";
import net from "node:net";
import { env, isProduction } from "../config/env.js";
import { HttpError } from "../http/middleware/errors.js";

// Fix 6: Explicitly block cloud metadata hostnames in addition to the CIDR blocklist.
// 169.254.169.254 is already covered by 169.254.0.0/16 in isBlockedIpAddress,
// but hostname-level blocking adds defence-in-depth against DNS tricks.
const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.azure.com"
]);

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(address: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (baseInt & mask);
}

function ipv4Hextets(address: string): [number, number] | null {
  const value = ipv4ToInt(address);
  if (value === null) return null;
  return [(value >>> 16) & 0xffff, value & 0xffff];
}

function parseIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const tail = normalized.slice(lastColon + 1);
    const hextets = ipv4Hextets(tail);
    if (!hextets) return null;
    normalized = `${normalized.slice(0, lastColon)}:${hextets[0].toString(16)}:${hextets[1].toString(16)}`;
  }

  const pieces = normalized.split("::");
  if (pieces.length > 2) return null;

  const parseSide = (side: string) =>
    side
      ? side.split(":").map((part) => {
          if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
          return Number.parseInt(part, 16);
        })
      : [];

  const head = parseSide(pieces[0] ?? "");
  const tail = parseSide(pieces[1] ?? "");
  if (head.some((part) => part === null) || tail.some((part) => part === null)) return null;

  if (pieces.length === 1) return head.length === 8 ? (head as number[]) : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...(head as number[]), ...Array.from({ length: missing }, () => 0), ...(tail as number[])];
}

export function isBlockedIpAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const value = ipv4ToInt(address);
    if (value === null) return true;
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4]
    ].some(([base, bits]) => ipv4InCidr(value, base as string, bits as number));
  }

  if (net.isIP(address) === 6) {
    const parts = parseIpv6(address);
    if (!parts) return true;
    const isUnspecified = parts.every((part) => part === 0);
    const isLoopback = parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1;
    const isMappedV4 = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
    if (isMappedV4) {
      const mapped = `${parts[6]! >>> 8}.${parts[6]! & 0xff}.${parts[7]! >>> 8}.${parts[7]! & 0xff}`;
      return isBlockedIpAddress(mapped);
    }
    return (
      isUnspecified ||
      isLoopback ||
      (parts[0]! & 0xfe00) === 0xfc00 ||
      (parts[0]! & 0xffc0) === 0xfe80 ||
      (parts[0]! & 0xff00) === 0xff00 ||
      (parts[0] === 0x2001 && parts[1] === 0x0db8)
    );
  }

  return true;
}

function assertSafeHostname(hostname: string): void {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized || blockedHostnames.has(normalized) || normalized.endsWith(".localhost")) {
    throw new HttpError(422, "Webhook URL must not target localhost");
  }
}

async function assertPublicDns(hostname: string): Promise<void> {
  assertSafeHostname(hostname);

  if (net.isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) throw new HttpError(422, "Webhook URL must not target private networks");
    return;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new HttpError(422, "Webhook host did not resolve");
  const blocked = records.find((record) => isBlockedIpAddress(record.address));
  if (blocked) throw new HttpError(422, "Webhook host resolves to a private network");
}

export async function validateUserWebhookUrl(rawUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(422, "Webhook URL is invalid");
  }

  if (parsed.username || parsed.password) {
    throw new HttpError(422, "Webhook URL credentials are not allowed");
  }

  const allowHttp = !isProduction;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw new HttpError(422, env.NODE_ENV === "production" ? "Webhook URL must use HTTPS" : "Webhook URL must use HTTP or HTTPS");
  }

  await assertPublicDns(parsed.hostname);
  return parsed.toString();
}
