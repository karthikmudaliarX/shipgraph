/**
 * Provider-neutral handling for text that may be retained as execution
 * evidence. Concrete adapters and the execution core use the same bounded
 * redaction policy without making the core depend on a provider module.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/gu,
      '[REDACTED_SECRET]'
    )
    .replace(
      /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^\s"']+\2/giu,
      '$1[REDACTED_SECRET]'
    );
}
