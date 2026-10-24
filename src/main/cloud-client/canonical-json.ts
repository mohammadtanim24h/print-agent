/**
 * Canonical JSON — the byte-exact serialization the `sig` in api-contract §2
 * is computed over (`base64url(ed25519(signing_key, canonical_json(job)))`).
 *
 * Canonical form (additively documented in api-contract.md §2):
 * - object keys sorted by UTF-16 code unit, recursively
 * - no whitespace, UTF-8 encoded
 * - numbers as JSON.stringify emits them (the doc model restricts amounts to
 *   safe integers, so no float-formatting ambiguity exists in v1)
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(',')}}`;
  }
  // undefined / functions / bigint / symbol have no JSON representation —
  // reject loudly rather than emit an ambiguous serialization (payloads are
  // schema-validated before signing, so this is unreachable in practice).
  throw new TypeError('canonicalJson: value is not JSON-serializable');
}
