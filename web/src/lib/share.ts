import { compressSync, decompressSync, strFromU8, strToU8 } from "fflate";
import type { SharePayload } from "../types";

const PREFIX = "#share=";
export const MAX_SHARE_URL_LENGTH = 8192;

function toBase64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64URL(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodeShare(payload: SharePayload): string {
  return PREFIX + toBase64URL(compressSync(strToU8(JSON.stringify(payload)), { level: 9 }));
}

export function decodeShare(hash: string): SharePayload | null {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const parsed = JSON.parse(strFromU8(decompressSync(fromBase64URL(hash.slice(PREFIX.length))))) as Partial<SharePayload>;
    const resultMode = parsed.resultMode as string | undefined;
    if (
      parsed.v !== 1 ||
      typeof parsed.query !== "string" ||
      typeof parsed.sourceId !== "string" ||
      typeof parsed.title !== "string" ||
      !parsed.tenant ||
      typeof parsed.tenant.accountId !== "string" ||
      typeof parsed.tenant.projectId !== "string" ||
      !["log", "table", "json"].includes(resultMode ?? "")
    ) return null;
    return { ...parsed, resultMode: resultMode === "json" ? "json" : "table" } as SharePayload;
  } catch {
    return null;
  }
}

export function shareURL(payload: SharePayload, location: Pick<Location, "origin" | "pathname"> = window.location): string {
  return `${location.origin}${location.pathname}${encodeShare(payload)}`;
}

export function sharedTabId(hash: string): string {
  let value = 2166136261;
  for (let index = 0; index < hash.length; index += 1) {
    value ^= hash.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return `shared-${(value >>> 0).toString(36)}`;
}
