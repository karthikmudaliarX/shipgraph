/** Locale-independent ordering for deterministic IDs and priorities. */
export function compareStableStrings(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}
