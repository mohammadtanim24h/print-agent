/**
 * Pure redaction for log lines and structured values.
 * CLAUDE.md rules 6/7: logs never contain credentials or PII.
 */

const REDACTED = {
  token: '[REDACTED:token]',
  field: '[REDACTED:field]',
  value: '[REDACTED:value]',
  email: '[REDACTED:email]',
  hexSecret: '[REDACTED:hex-secret]',
  truncated: '[REDACTED:truncated-depth]',
  cycle: '[REDACTED:cycle]',
} as const;

// Applied in order: cheapest/most-specific first. Field pattern last so
// token/email/hex patterns get first claim on values they fully describe.
const STRING_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+\S+/gi, REDACTED.token],
  // JWT-ish: three base64url segments
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED.token],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, REDACTED.email],
  // long hex secrets (>= 32 hex chars)
  [/\b[0-9a-f]{32,}\b/gi, REDACTED.hexSecret],
  // secret-ish key=value / "key":"value" pairs — key name is sensitive too
  [
    /["']?(deviceKey|device_key|token|access_token|refresh_token|secret|password|passphrase|authorization|api[_-]?key)["']?\s*[:=]\s*["']?[^\s,"'}]+["']?/gi,
    `${REDACTED.field}:${REDACTED.value}`,
  ],
];

const SECRETISH_KEY = /device_?key|token|secret|password|passphrase|authorization|api[_-]?key/i;

const MAX_INPUT_LENGTH = 1024 * 1024;
const MAX_DEPTH = 8;

export function redactString(input: string): string {
  let out =
    input.length > MAX_INPUT_LENGTH ? input.slice(0, MAX_INPUT_LENGTH) + REDACTED.truncated : input;
  for (const [re, replacement] of STRING_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

export function redactValue(input: unknown, depth = 0): unknown {
  const walk = (value: unknown, d: number, active: Set<object>): unknown => {
    if (d > MAX_DEPTH) return REDACTED.truncated;
    if (value === null || typeof value !== 'object') {
      return typeof value === 'string' ? redactString(value) : value;
    }
    if (active.has(value)) return REDACTED.cycle;
    active.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => walk(item, d + 1, active));
      }
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        // Key names are not secrets (keep for debuggability); their values are.
        if (SECRETISH_KEY.test(key) && typeof val === 'string') {
          out[key] = REDACTED.value;
        } else {
          out[key] = walk(val, d + 1, active);
        }
      }
      return out;
    } finally {
      active.delete(value);
    }
  };
  return walk(input, depth, new Set());
}
