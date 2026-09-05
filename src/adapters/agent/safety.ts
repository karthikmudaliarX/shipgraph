/**
 * Provider-neutral handling for text that may be retained as execution
 * evidence. Concrete adapters and the execution core use the same bounded
 * redaction policy without making the core depend on a provider module.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|xai-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9._-]{16,}|AKIA[A-Z0-9]{16})\b/gu,
      '[REDACTED_SECRET]'
    )
    .replace(
      /\bAuthorization\s*:\s*(Bearer|Basic)\s+[^\s"',;]+/giu,
      'Authorization: $1 [REDACTED_SECRET]'
    )
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu,
      'Bearer [REDACTED_SECRET]'
    )
    .replace(
      /((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|credential[s]?|token|secret|password)["']?)\s*[:=]\s*)(?:(")(?:\\.|[^"\\\r\n])*\2|(')(?:\\.|[^'\\\r\n])*\3|([^\s"'`,;}\]]+))/giu,
      (_match, prefix: string, doubleQuote: string | undefined, singleQuote: string | undefined) =>
        `${prefix}${doubleQuote ?? singleQuote ?? ''}[REDACTED_SECRET]${doubleQuote ?? singleQuote ?? ''}`
    )
    .replace(
      /((?:\\["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|credential[s]?|token|secret|password)\\["'])\s*[:=]\s*)(\\["'])[^\\\r\n]*?\2/giu,
      '$1$2[REDACTED_SECRET]$2'
    );
}

/** Redaction can expand a short secret; bound the redacted UTF-8 result too. */
export function boundedRedactedOutput(value: string, limit: number, prefixTruncated = false): { text: string; truncated: boolean } {
  // A cut credential may no longer match the complete quoted-secret pattern.
  // Discard the incomplete retained line before redaction; do not expose fragments.
  const completePrefix = prefixTruncated ? value.slice(0, value.lastIndexOf('\n') + 1) : value;
  const redacted = redactSensitiveText(completePrefix);
  const bytes = Buffer.from(redacted);
  if (bytes.length <= limit) return { text: redacted, truncated: false };
  return {
    text: new TextDecoder('utf-8').decode(bytes.subarray(0, limit), { stream: true }),
    truncated: true,
  };
}
