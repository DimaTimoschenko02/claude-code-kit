// Secret redaction for anything extracted out of transcripts.
// Transcripts are full of live credentials; an audit report gets written into
// project memory and committed. Everything leaving the extractor passes here.
//
// Two consumers share one set of shapes:
//   scrub(text)        — redaction: the value is replaced, the context kept (extract.mjs, facts slice);
//   findSecrets(text)  — detection: a strict gate (e.g. a memory harvester's commit gate) refuses on any hit.
// DETECTORS carry a value group; a value that is a placeholder, a variable or an env var NAME is not a
// secret (memory is supposed to hold `see <access note> → …` and `$DB_PASSWORD`, never the value).
// Shapes were taken from real transcripts; values in tests are synthetic.
// JS `\b` is ASCII-only — every Cyrillic boundary below is a `\p{L}` lookaround instead.

// ------------------------------------------------------------- value checks

const PLACEHOLDER = new RegExp(
  '^(?:' + [
    '\\[[A-Z_ ]+\\]?',                // [REDACTED], [API_KEY] (clean() may eat the `]`)
    '\\*+', '…+', '\\.{2,}', '_+', '-+',
    '<[^>]*>', '\\{\\{[^}]*\\}\\}', '%\\w+%', '__[A-Z][A-Z0-9_]*__',   // __DB_PASSWORD__ template token
    '\\$\\{?[A-Za-z_][\\w]*\\}?.*',     // $VAR, ${VAR}, $(cmd …
    '\\\\\\$.*',                      // \$VAR inside quoted shell
    '[xX]{3,}', 'pass(?:word)?', 'pwd', 'pw', 'secret', 'user(?:name)?', 'value', 'val', 'changeme',
    'your[_-]?\\w*', 'example', 'redacted', 'hidden', 'masked', 'none', 'null', 'nil', 'undefined',
    'true', 'false', 'string', 'number', 'boolean', 'required', 'optional', 'any', 'unknown', 'empty',
    'env', 'see', 'token', 'basic', 'bearer', 'host', 'port', 'dbname', 'database', 'login', 'name',
  ].join('|') + ')$', 'i',
);
// Words that follow «пароль» / «пасс» as a subject, not as the value («пароль от gmail»).
const RU_NOUN = /^(?:gmail|google|mysql|mariadb|postgres(?:ql)?|imap|smtp|ssh|sftp|ftp|odata|bas|db|env|http|https|basic|auth|oauth|app|wifi|vpn|api|sudo|git|github|redis|notion|admin|root-?доступ)$/i;
const ENV_NAME = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;        // DB_PASSWORD — a name, not a value
const NUMERIC = /^[\d.,_:+-]+[kKmMbB%]?$/;              // tokens: 263k, port 5432
const PATHLIKE = /^(?:~|\.{1,2})?\/[^\s/]+\/|^[\w.-]+\/[\w.-]+\//;
const CODE_REF = /^(?:process\.env|env|config|this|ctx|opts?|options|settings|cfg|secrets|args|req|res|self)\.\w|[()]/;

// Rules whose key is an explicit password word/flag — there even an all-digit value is a password.
const PASSWORD_RULES = new Set(['db-cli-p', 'ru-password', 'en-password', 'cli-password', 'sql-password']);

/** A bare English value after «password …» must look like a secret, not a word («password reset», «is required»). */
function looksSecret(v) {
  const c = clean(v);
  return /\d/.test(c) || /^.+[A-Z]/.test(c) || /[!@#$%^&*_+=?~|\\]/.test(c);
}

const COMMON4 = new Set(('must have been sent with from that this will into your they them then than when what here ' +
  'some only also just like more used uses once each same such were does done make made take need goes lives kept ' +
  'stay read work file mail sets sent').split(' '));

function clean(v) {
  return String(v || '')
    .replace(/^[`"'*«]+/, '')
    .replace(/[`"'*».,;:!?)\]}]+$/, '');
}

/** Is `raw` (the captured value) a literal secret rather than a placeholder/name/reference? */
export function isRealValue(raw, { min = 4, rule = '' } = {}) {
  const v = clean(raw);
  if (v.length < min) return false;
  if (PLACEHOLDER.test(v)) return false;
  if (/^\[[A-Z_]+\]/.test(v)) return false;             // already scrubbed
  // A number is a secret only after an explicit password key (`пароль 84736251`); 2–5 digits there is a port/year.
  if (NUMERIC.test(v) && !(PASSWORD_RULES.has(rule) && /^\d{6,}$/.test(v))) return false;
  if (ENV_NAME.test(v)) return false;
  if (PATHLIKE.test(v)) return false;
  if (CODE_REF.test(v)) return false;
  return true;
}

// ----------------------------------------------------------------- detectors
// Each: { name, re (global, with the `d` flag for group indices), group: value group name, min?, check? }.

const KEY_NAMES = [
  'passw(?:or)?d', 'passwort', 'passphrase', '(?<![A-Za-z])pass(?![A-Za-z])', 'pwd', 'pgpassword',
  'secret', 'token(?![a-rt-z])', 'api[_-]?key', 'apikey', 'access[_-]?key', 'private[_-]?key',
  'client[_-]?secret', 'credentials?', 'app[_-]?password',
].join('|');

export const DETECTORS = [
  // Whole-token provider shapes — the match itself is the value.
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gd },
  { name: 'api-key-sk', re: /\bsk-[A-Za-z0-9_-]{16,}/gd },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/gd },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/gd },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/gd },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{20,}/gd },
  { name: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{16,}/gd },
  // Notion (ntn_, legacy secret_), Stripe, npm, Hugging Face, Linear, Atlassian, Sentry, DigitalOcean, Slack app-level.
  { name: 'prefixed-token',
    re: /\b(?:ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{40,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|lin_api_[A-Za-z0-9]{32,}|ATATT[A-Za-z0-9_=-]{40,}|sntry[su]_[A-Za-z0-9_=+/-]{40,}|dop_v1_[a-f0-9]{64}|xapp-\d-[A-Za-z0-9-]{20,})/gd },
  // Telegram bot token: <bot id>:AA<33 chars>.
  { name: 'telegram-bot-token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/gd },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gd },
  { name: 'hex-blob', re: /\b[A-Fa-f0-9]{48,}\b/gd },

  // Authorization: Basic <b64> / Bearer <token>. A plain word («Basic authentication») is not a credential.
  {
    name: 'auth-header', group: 'v', min: 8,
    re: /\b(?:Basic|Bearer|Token)\s+(?<v>[A-Za-z0-9._~+/=-]{8,})/gd,
    check: (v) => /[\d=+/]/.test(v) || v.length >= 20,
  },
  // scheme://user:pass@host
  { name: 'url-credentials', group: 'v', min: 3,
    re: /[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:(?<v>[^\s@/'"`]+)@/gid },
  // user:pass@host without a scheme (not a git remote: that has no colon before @).
  { name: 'host-credentials', group: 'v', min: 3,
    re: /(?<![\w/:.@-])[A-Za-z0-9._-]{1,64}:(?<v>[^\s:@/'"`]{3,})@(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gd },
  // curl -u user:pass / --user user:pass (also wget/httpie).
  { name: 'curl-user', group: 'v', min: 3,
    re: /\b(?:curl|wget|https?|httpie)\b[^\n|;]*?\s(?:-[A-Za-z]*u|--user|--auth|-a)[\s=]+["']?[^\s:'"]+:(?<v>[^\s'"@]+)/gd },
  // mysql/mariadb/psql … -p<val> | -p <val> ; sshpass -p <val>. `-p$VAR`, `-p "$VAR"`, `psql -p 5432` pass.
  { name: 'db-cli-p', group: 'v', min: 3,
    re: /\b(?:mysql|mariadb|mysqldump|mariadb-dump|mysqladmin|mysqlsh|psql|pg_dump|pg_restore|pg_dumpall|sshpass|kdb)\b[^\n|;&]*?\s-p\s*["']?(?<v>[^\s'"`$\\-][^\s'"`]*)/gd },
  // key = value / key: value for secret-ish names, incl. `.env` lines, YAML, JSON, `**Password:** x`.
  { name: 'key-value', group: 'v',
    re: new RegExp(`(?<![\\p{L}\\d])(?:[\\w.-]*?(?:${KEY_NAMES})[\\w.-]*)\\**["'\`]?\\s*\\**\\s*(?:[:=]|=>)\\s*\\**\\s*["'\`]?(?<v>[^\\s"'\`,;)}\\]]+)`, 'giud') },
  // Cyrillic keys: «пароль: x», «пароль `x`», «пароль приложения `x`», «пасс x», «логин `a`, пароль `b`».
  // Up to 3 context words (each with a Cyrillic letter) may sit between the key and the value.
  { name: 'ru-password', group: 'v',
    re: /(?<!\p{L})(?:парол[ьяюеіи]\p{L}*|пасс(?:ворд)?|пассвор\p{L}*)(?!\p{L})(?:\s+[^\s`]*\p{Script=Cyrillic}[^\s`]*){0,3}?(?:\s*[:=—–-]\s*|\s+)(?:\*\*\s*)?(?:`(?<v>[^`\n]{3,})`|(?<v2>[\x21-\x7e]{4,})(?![\p{L}\d]))/giud,
    alt: 'v2',
    check: (v, bare) => !(bare && RU_NOUN.test(clean(v))) },
  // English keys: «password `x`», «The admin password is x», «user `a` with password `b`»,
  // «pw: x», «app password `qwer tyui opas dfgh`». Up to 4 connector/subject words between key and value.
  // A backtick or `:`/`=` value counts as is; a bare value after a space must look like a secret (looksSecret).
  // `--password-file`, `password?: string`, «password is required» pass.
  { name: 'en-password', group: 'v', alt: 'v2',
    re: /(?<![\w-])(?:app[ _-]?)?(?:passw(?:or)?d|passphrase|pwd?)(?![\w-])(?:[ \t]+(?:is|was|are|now|still|for|of|to|on|the|an?|admin|root|user|db|database|mysql|mariadb|postgres|app|gmail|google|smtp|imap|ssh|sftp|ftp|new|old|test|here|set|stays?|remains?|`[^`\s]{1,40}`)){0,4}?(?<sep>[ \t]*[:=—–][ \t]*|[ \t]+)(?:\*\*[ \t]*)?(?:`(?<v>[^`\n]{3,})`|(?<v2>[\x21-\x7e]{4,})(?![\p{L}\d]))/giud,
    check: (v, bare, m) => !bare || /[:=]/.test(m.groups.sep) || looksSecret(v) },
  // CLI long flag with a space or `=`: `mysql --password X`, `--password=X`, `--pass X`. `--password-file`, `--password $PW` pass.
  { name: 'cli-password', group: 'v', min: 3,
    re: /(?<![\w-])--(?:password|passwd|pass|pwd)(?:=|[ \t]+)["']?(?<v>[^\s'"`$\\-][^\s'"`]*)/gd },
  // SQL literals: `CREATE USER … IDENTIFIED BY 'x'`, `IDENTIFIED WITH plugin BY 'x'`, Postgres `… PASSWORD 'x'`,
  // `SET PASSWORD = PASSWORD('x')`. `IDENTIFIED BY '$PW'` passes (placeholder).
  { name: 'sql-password', group: 'v', min: 3,
    re: /\b(?:IDENTIFIED(?:\s+WITH\s+\w+)?\s+BY(?:\s+PASSWORD)?|(?:ENCRYPTED\s+)?PASSWORD(?:\s*=\s*PASSWORD\s*\(|\s*=)?)\s*\(?\s*(?<q>['"])(?<v>[^'"\n]+)\k<q>/gid },
  // Gmail app password written bare as four groups of four letters after a password word (en or ru):
  // the backtick rules above catch `qwer tyui opas dfgh`, a bare one would lose three of its four groups.
  // Gmail generates lowercase random groups; «app password must have been sent» is prose (COMMON4).
  { name: 'app-password-bare', group: 'v',
    re: /(?:app[ _-]?password|пароль\s+приложени\p{L}*|парол\p{L}*\s+(?:от\s+)?(?:gmail|google|почты|пошти))[^\n]{0,60}?(?<![\p{L}\d])(?<v>[a-z]{4}(?:[ -][a-z]{4}){3})(?![\p{L}\d])/giud,
    check: (v) => v === v.toLowerCase() && v.split(/[ -]/).filter((w) => !COMMON4.has(w)).length >= 2 },
  // Backtick user / password pair after an auth word: «basic auth: `admin` / `ab123456`», «логин `a`, `b`».
  { name: 'cred-pair', group: 'v',
    re: /(?:basic[ -]?auth|логин\p{L}*|login|учётк\p{L}*|учетк\p{L}*|creds?|креды|credentials?)[^\n]{0,60}?`[^`\s]{1,64}`\s*(?:\/|,|и|:)\s*(?:пароль\s*)?`(?<v>[^`\s]{3,})`/giud },
  // Generic «`name` / `Password123abc`» (mixed case + digit, 12+) — kept from the audit scrubber.
  { name: 'slash-pair-strong', group: 'v',
    re: /\/\s+`?(?<v>(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{12,})`?/gd },
];

function* hits(text) {
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (const m of text.matchAll(d.re)) {
      let g = d.group;
      let bare = false;
      if (g && m.groups?.[g] === undefined && d.alt && m.groups?.[d.alt] !== undefined) { g = d.alt; bare = true; }
      const value = g ? m.groups?.[g] : m[0];
      if (value === undefined) continue;
      const [start, end] = g ? m.indices.groups[g] : m.indices[0];
      if (g && !isRealValue(value, { min: d.min ?? 4, rule: d.name })) continue;
      if (d.check && !d.check(value, bare, m)) continue;
      yield { rule: d.name, start, end };
    }
  }
}

/** Strict detection: every literal secret-shaped value, with offsets (never the value itself). */
export function findSecrets(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const h of hits(text)) {
    const line = text.slice(0, h.start).split('\n').length;
    out.push({ ...h, line });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------ redaction only

const RULES = [
  // key=value / key: value assignments for secret-ish names (audit-era rule, broader than the detector).
  [
    /\b((?:[A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z_]*))(\s*[:=]\s*)(["']?)([^\s"',;)]{4,})\3/gi,
    '$1$2$3[REDACTED]$3',
  ],
  // One-time codes stated next to the word.
  [/(?<!\p{L})(otp|одноразов\p{L}*|код подтверждения|verification code|2fa)(?!\p{L})([^\n]{0,20}?)\b\d{4,8}\b/giu, '$1$2 [OTP]'],
];

/** Redact secrets from a string. Returns the cleaned string. */
export function scrub(text) {
  if (typeof text !== 'string' || !text) return text;
  // Detector hits first, spliced from the end so earlier offsets stay valid. Overlaps merge.
  const spans = [...hits(text)].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) { last.end = Math.max(last.end, s.end); continue; }
    merged.push({ ...s });
  }
  let out = text;
  for (let i = merged.length - 1; i >= 0; i--) {
    const { start, end, rule } = merged[i];
    const tag = rule === 'private-key' ? '[PRIVATE_KEY]' : rule === 'hex-blob' ? '[HEX_BLOB]' : '[REDACTED]';
    out = out.slice(0, start) + tag + out.slice(end);
  }
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
