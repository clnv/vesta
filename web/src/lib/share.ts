const PREFIX = "#share=";
const TOKEN = /^[A-Za-z0-9_-]{32}$/;

export function shareURL(token: string, location: Pick<Location, "origin" | "pathname"> = window.location): string {
  return `${location.origin}${location.pathname}${PREFIX}${encodeURIComponent(token)}`;
}

export function shareTokenFromHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const token = decodeURIComponent(hash.slice(PREFIX.length));
    return TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function sharedTabId(hash: string): string {
  let value = 2166136261;
  for (let index = 0; index < hash.length; index += 1) {
    value ^= hash.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return `shared-${(value >>> 0).toString(36)}`;
}
