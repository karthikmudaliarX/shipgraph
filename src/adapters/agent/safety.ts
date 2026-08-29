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
