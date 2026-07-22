export function appendToRing<T>(current: T[], incoming: T[], capacity: number): { rows: T[]; dropped: number } {
  const combined = [...current, ...incoming];
  if (combined.length <= capacity) return { rows: combined, dropped: 0 };
  const dropped = combined.length - capacity;
  return { rows: combined.slice(dropped), dropped };
}
