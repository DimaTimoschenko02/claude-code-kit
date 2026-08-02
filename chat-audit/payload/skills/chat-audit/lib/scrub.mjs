// Secret redaction for anything extracted out of transcripts.
// Transcripts are full of live credentials; an audit report gets written into
// project memory and committed. Everything leaving the extractor passes here.

const RULES = [
  // Private keys / certs — kill the whole block.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE_KEY]'],
  // Provider-shaped tokens.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[API_KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '[GITHUB_TOKEN]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[SLACK_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[AWS_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[GOOGLE_KEY]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, '[GITLAB_TOKEN]'],
  // JWT.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[JWT]'],
  // Authorization headers.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]'],
  // Credentials inside URLs: scheme://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, '$1$2:[REDACTED]@'],
  // key=value / key: value assignments for secret-ish names.
  [
    /\b((?:[A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z_]*))(\s*[:=]\s*)(["']?)([^\s"',;)]{4,})\3/gi,
    '$1$2$3[REDACTED]$3',
  ],
  // One-time codes stated next to the word.
  [/\b(otp|одноразов\w*|код подтверждения|verification code|2fa)\b([^\n]{0,20}?)\b\d{4,8}\b/gi, '$1$2 [OTP]'],
  // Long opaque hex blobs. Threshold is 48, not 40, so 40-char git SHA-1s
  // survive — commit hashes are load-bearing evidence in an audit, and a hash
  // is not a credential.
  [/\b[A-Fa-f0-9]{48,}\b/g, '[HEX_BLOB]'],
];

/** Redact secrets from a string. Returns the cleaned string. */
export function scrub(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [re, repl] of RULES) out = out.replace(re, repl);
  return out;
}

/** Redact recursively through plain objects/arrays. */
export function scrubDeep(value) {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}
