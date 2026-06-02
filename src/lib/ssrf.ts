// SSRF / DNS-rebinding guard.
//
// This server fetches arbitrary user-supplied URLs. Without a guard it is an
// SSRF vector: a caller could point it at 127.0.0.1, 169.254.169.254 (cloud
// metadata), or a hostname that RESOLVES to a private IP (DNS rebinding). We
// block private/loopback/link-local/reserved address space, syntactically for
// IP literals and after DNS resolution for hostnames.

import net from "node:net";
import { lookup } from "node:dns/promises";

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;          // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;          // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                         // multicast/reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fe80")) return true;          // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique-local
    const mapped = low.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

/**
 * Returns a human-readable reason if the host must be blocked, else null.
 * Resolves hostnames so DNS-rebinding to a private IP is also caught.
 */
export async function ssrfBlockReason(hostname: string): Promise<string | null> {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return "empty host";
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) {
    return `host "${hostname}" is internal`;
  }
  if (net.isIP(h)) {
    return isPrivateIp(h) ? `IP ${hostname} is in private/reserved space` : null;
  }
  try {
    const addrs = await lookup(h, { all: true });
    for (const a of addrs) {
      if (isPrivateIp(a.address)) return `host ${hostname} resolves to private IP ${a.address}`;
    }
  } catch {
    // Resolution failure — let the actual fetch fail naturally rather than
    // blocking a host we simply couldn't resolve here.
    return null;
  }
  return null;
}
