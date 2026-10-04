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
// Callers that keep only part of a text cut it with scrubHead/scrubTail: a cut made first can halve a token so that no
// shape matches what is left.
//
// Known gaps (measured by an adversarial probe 2026-10-04, rare in our transcripts, left open):
//   - a value with no secret-ish name and no provider shape: `redis-cli -a X`, `docker login -p X`, `ldapsearch -w X`,
//     `smbclient -U u%X`, `htpasswd -b f u X`, `jq -r .password` output, a cookie value;
//   - DSN edges: an empty user (`redis://:X@h`), `@` or `/` inside the password, a JSON-escaped `\/` scheme;
//   - URL-encoded text (`%3D`, `%20Bearer%20`), grep colour codes splitting a token in two, `\x1b(B`;
//   - base64 that is not a known shape: a k8s Secret's data values, a docker `auths` blob;
//   - a key written only as `\uXXXX` escapes (Cyrillic «пароль» in JSON), an XML attribute pair `key="Password" value="X"`,
//     a setter call `setPassword('X')`, webhook URLs;
//   - a value whose JSON escape (`\"`) sits inside it is masked up to the escape only;

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
    'enabled', 'disabled',
  ].join('|') + ')$', 'i',
);
// Words that follow «пароль» / «пасс» as a subject, not as the value («пароль от gmail»).
const RU_NOUN = /^(?:gmail|google|mysql|mariadb|postgres(?:ql)?|imap|smtp|ssh|sftp|ftp|odata|bas|db|env|http|https|basic|auth|oauth|app|wifi|vpn|api|sudo|git|github|redis|notion|admin|root-?доступ)$/i;
const ENV_NAME = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;        // DB_PASSWORD — a name, not a value
const NUMERIC = /^[\d.,_:+-]+[kKmMbB%]?$/;              // tokens: 263k, port 5432
// A relative path has two slashes and ends in a file extension or a slash; base64 with slashes (`s7pOW/GZkVNZ/imYP`)
// ends in neither.
const PATHLIKE = /^(?:~|\.{1,2})?\/[^\s/]+\/|^[\w.-]+(?:\/[\w.-]+)+\/(?:[\w-]*\.[A-Za-z0-9]{1,5})?$/;
// A member access, a call, a parenthesised expression; `XoI)uu6bY7JR` is a password, not code.
const CODE_REF = /^(?:process\.env|env|config|this|ctx|opts?|options|settings|cfg|secrets|args|req|res|self)\.\w|^[\w.$]+\(|^\(/;
// A member access that names the secret instead of holding it: `dto.password`, `user.passwordHash`. A bare camelCase
// word is not taken for code — it can be a password.
const IDENT_REF = /^[A-Za-z_$]+(?:\.[A-Za-z_$]+)+$/;
const SECRET_WORD = /pass|pwd|secret|token|key|cred|auth|hash/i;
// A key that describes a secret instead of holding it: `secretName`, `token_type`, `passwordHash`, `secretKeyRef`.
// No `id` (Vault's `secret_id` is a secret), `hash` or `header` (both can hold one).
const META = 'name|type|count|len|length|file|path|dir|url|uri|field|mode|hint|label|prompt|ref|ttl|provider|format|version|expiry|expires|prefix';
const META_SNAKE = new RegExp(`[_.-](?:${META})s?$`, 'i');
const META_CAMEL = new RegExp(`(?<=[a-z])(?:${META.replace(/\b\w/g, (c) => c.toUpperCase())})s?$`);
const describesSecret = (key) => META_SNAKE.test(key) || META_CAMEL.test(key);
const GMAIL_APP = /^[a-z]{4}(?: [a-z]{4}){3}$/;
/** A quoted value with spaces is a secret only when short and secret-looking, or a Gmail app password — not a message. */
const quotedSecret = (v) => !/\s/.test(v) || GMAIL_APP.test(v) || (v.trim().split(/\s+/).length <= 3 && looksSecret(v));

// Rules whose key is an explicit password word/flag — there even an all-digit value is a password; the same for a
// key-value pair whose key is a password word (`DB_PASSWORD=84736251`).
const PASSWORD_RULES = new Set(['db-cli-p', 'ru-password', 'en-password', 'cli-password', 'sql-password']);
const PASSWORD_KEY = /pass|pwd|secret|(?<![a-z])pin(?![a-z])/i;

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
export function isRealValue(raw, { min = 4, rule = '', key = '' } = {}) {
  const v = clean(raw);
  if (v.length < min) return false;
  if (PLACEHOLDER.test(v)) return false;
  if (/^\[[A-Z_]+\]/.test(v)) return false;             // already scrubbed
  // A number is a secret only after an explicit password key: 6+ digits in prose (`пароль 84736251`; 2–5 digits there is
  // a port or a year), 4+ under a password-named key (`DB_PASS=4821`).
  if (NUMERIC.test(v) && !((PASSWORD_RULES.has(rule) && /^\d{6,}$/.test(v)) || (PASSWORD_KEY.test(key) && /^\d{4,}$/.test(v)))) return false;
  if (ENV_NAME.test(v)) return false;
  if (PATHLIKE.test(v)) return false;
  if (CODE_REF.test(v)) return false;
  if (IDENT_REF.test(v) && SECRET_WORD.test(v)) return false;
  return true;
}

// ----------------------------------------------------------------- detectors
// Each: { name, re (global, with the `d` flag for group indices), group: value group name, min?, check? }.

const KEY_NAMES = [
  'passw(?:or)?d', 'passwort', 'passphrase', '(?<![A-Za-z])pass(?![A-Za-z])', 'pwd', 'pgpassword',
  'secret', 'token(?![a-rt-z])', 'api[_-]?key', 'apikey', 'access[_-]?key', 'private[_-]?key',
  'client[_-]?secret', 'credentials?', 'app[_-]?password', '(?<![A-Za-z])auth(?!or)',
].join('|');
// Bounded on both sides: an unbounded run made every start position rescan a long word (quadratic on base64/hex).
const SECRET_KEY = `[\\w.-]{0,64}?(?:${KEY_NAMES})[\\w.-]{0,64}`;
// After `=`/`:` either a quoted value (may hold spaces and `)`) or a bare run.
const QUOTED = `(?<q>["'\`])(?<v>[^"'\`\\n]{3,200}?)\\k<q>`;

export const DETECTORS = [
  // Whole-token provider shapes — the match itself is the value.
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/gd },
  // A PEM block in base64 (kubeconfig `client-key-data`, k8s Secrets): base64 of «-----BEGIN». Certificates go too.
  { name: 'pem-base64', re: /\bLS0tLS1CRUdJTi[A-Za-z0-9+/=]{20,}/gd },
  { name: 'api-key-sk', re: /\bsk-[A-Za-z0-9_-]{16,}/gd, check: (v) => /\d/.test(v) },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/gd },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/gd },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/gd },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{20,}/gd },
  { name: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{16,}/gd },
  // Notion (ntn_, legacy secret_), Stripe, npm, Hugging Face, Linear, Atlassian, Sentry, DigitalOcean, Slack app-level.
  { name: 'prefixed-token',
    re: /\b(?:ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{40,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|lin_api_[A-Za-z0-9]{32,}|ATATT[A-Za-z0-9_=-]{40,}|sntry[su]_[A-Za-z0-9_=+/-]{40,}|dop_v1_[a-f0-9]{64}|xapp-\d-[A-Za-z0-9-]{20,})/gd },
  // Telegram bot token: <bot id>:AA<33 chars>, also inside its API URL (`/bot<token>/sendMessage`, a letter before it).
  { name: 'telegram-bot-token', re: /(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/gd },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gd },
  // A long hex run, `0x` private keys too; a content digest (`@sha256:…`) is a hash, not a secret.
  { name: 'hex-blob', re: /(?<!sha\d{1,3}:)(?:\b0x|\b)[A-Fa-f0-9]{48,}\b/gd },

  // Authorization: Basic <b64> / Bearer <token>, any case. A plain word («Basic authentication») is not a credential.
  {
    name: 'auth-header', group: 'v', min: 8,
    re: /\b(?:Basic|Bearer|Token)\s+(?<v>[A-Za-z0-9._~+/=-]{8,})/gid,
    check: (v) => /[\d=+/]/.test(v) || v.length >= 20,
  },
  // scheme://user:pass@host. Every run is bounded: serialized JSON is one line of megabytes, and an unbounded run
// rescanned from each start position is quadratic there.
  { name: 'url-credentials', group: 'v', min: 3,
    re: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/'"`]{1,256}:(?<v>[^\s@/'"`]+)@/gid },
  // user:pass@host without a scheme (not a git remote: that has no colon before @).
  { name: 'host-credentials', group: 'v', min: 3,
    re: /(?<![\w/:.@-])[A-Za-z0-9._-]{1,64}:(?<v>[^\s:@/'"`]{3,})@(?:localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gd },
  // curl -u user:pass / -uuser:pass / --user user:pass (also wget/httpie).
  { name: 'curl-user', group: 'v', min: 3,
    re: /\b(?:curl|wget|https?|httpie)\b[^\n|;]{0,2000}?\s(?:-[A-Za-z]*u[\s=]*|(?:--user|--auth|-a)[\s=]+)["']?[^\s:'"]+:(?<v>[^\s'"@]+)/gd },
  // mysql/mariadb/psql … -p<val> | -p <val> ; sshpass -p <val>. `-p$VAR`, `-p "$VAR"`, `psql -p 5432` pass.
  { name: 'db-cli-p', group: 'v', min: 3,
    re: /\b(?:mysql|mariadb|mysqldump|mariadb-dump|mysqladmin|mysqlsh|psql|pg_dump|pg_restore|pg_dumpall|sshpass|kdb)\b[^\n|;&]{0,2000}?\s-p\s*["']?(?<v>[^\s'"`$\\-][^\s'"`]*)/gd },
  // key = value / key: value / 'key' => value for secret-ish names, incl. `.env` lines, YAML, JSON, PHP arrays,
  // `**Password:** x`. A key that describes the secret (`secretName`, `token_type`) holds no value.
  { name: 'key-value', group: 'v',
    re: new RegExp(`(?<![\\p{L}\\d])(?<k>${SECRET_KEY})\\**["'\`]?\\s*\\**\\s*(?:=>|[:=])\\s*\\**\\s*["'\`]?(?<v>[^\\s"'\`,;}\\]]*[^\\s"'\`,;)}\\]])`, 'giud'),
    check: (v, bare, m) => !describesSecret(m.groups.k) },
  // The same with the value quoted whole: `IMAP_PASSWORD="abcd efgh ijkl mnop"`, `password="XoI)uu6b"`.
  { name: 'key-value-quoted', group: 'v',
    re: new RegExp(`(?<![\\p{L}\\d])(?<k>${SECRET_KEY})\\**["'\`]?\\s*\\**\\s*(?:=>|[:=])\\s*\\**\\s*${QUOTED}`, 'giud'),
    check: (v, bare, m) => !describesSecret(m.groups.k) && quotedSecret(v) },
  // An env-style name ending in _KEY/_PW/_AUTH/_SALT that KEY_NAMES does not cover: `ENCRYPTION_KEY=…`, `APP_KEY=base64:…`.
  { name: 'env-key', group: 'v',
    re: /(?<![\w])[A-Z][A-Z0-9_]*_(?:KEY|PW|AUTH|SALT|PASSPHRASE)(?![\w])\s*[:=]\s*["']?(?<v>[^\s"'`,;}\]]*[^\s"'`,;)}\]])/gd,
    check: (v) => looksSecret(v) },
  // A secret name passed with its literal: `define('DB_PASSWORD', 'x')`, `getenv("API_KEY", "x")`, `('password', 'x')`.
  { name: 'name-literal', group: 'v',
    re: new RegExp(`(?<kq>["'])(?<k>${SECRET_KEY})\\k<kq>\\s*,\\s*${QUOTED}`, 'giud'),
    check: (v, bare, m) => !describesSecret(m.groups.k) && quotedSecret(v) },
  // A literal fallback after a secret reference: `process.env.DB_PASSWORD || 'x'`, `env.API_TOKEN ?? 'x'`.
  { name: 'fallback-literal', group: 'v',
    re: new RegExp(`(?<![\\p{L}\\d])${SECRET_KEY}[\\]'"\`)]*\\s*(?:\\|\\||\\?\\?)\\s*${QUOTED}`, 'giud'),
    check: (v) => quotedSecret(v) },
  // An XML element: `<password>x</password>`, `<api-key>x</api-key>`.
  { name: 'xml-element', group: 'v',
    re: new RegExp(`<(?<t>${SECRET_KEY.replaceAll('[\\w.-]', '[\\w:.-]')})>(?<v>[^<\\n]{3,200})</\\k<t>>`, 'giud') },
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
  // `SET PASSWORD = PASSWORD('x')`. `IDENTIFIED BY '$PW'` passes (placeholder). A quoted key (`'password' => 'x'`)
  // is not SQL: the word must not sit inside quotes, or its own closing quote opens the «value».
  { name: 'sql-password', group: 'v', min: 3,
    re: /\b(?:IDENTIFIED(?:\s+WITH\s+\w+)?\s+BY(?:\s+PASSWORD)?\s*|(?<![\w'"`])(?:ENCRYPTED\s+)?PASSWORD(?:\s*=\s*PASSWORD\s*\(\s*|\s*=\s*|\s+))(?<q>['"])(?<v>[^'"\n]+)\k<q>/gid },
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

// A token right after a JSON escape ("\n", "\u001b[0m") or a raw terminal colour code sits behind a letter, so no \b
// fires; a value in escaped quotes (`PASSWORD=\"x\"` in a serialized command) starts with a backslash no value shape
// takes. Callers scrub serialized JSON and coloured output alike. The view blanks those sequences at the same length.
const BEHIND_LETTER = /\x1b\[[0-9;?]*[A-Za-z]|\\u001b\[[0-9;?]*[A-Za-z]|\\u[0-9a-fA-F]{4}|\\[nrtbf]|\\+["']/g;

/** Hits over the text and over its view: the text's own pass keeps a value that holds a literal "\t" whole, the view's
 *  pass adds what hid behind an escape. A view hit is dropped only when a text hit covers it whole — a partial overlap
 *  would leave the token's tail. */
function* hits(text) {
  const view = text.replace(BEHIND_LETTER, (s) => ' '.repeat(s.length));
  const own = [...passHits(text)];
  yield* own;
  if (view === text) return;
  // Text hits merged into sorted disjoint spans: a binary search per view hit, not a scan of every text hit.
  const spans = [];
  for (const o of [...own].sort((a, b) => a.start - b.start)) {
    const last = spans[spans.length - 1];
    if (last && o.start <= last.end) last.end = Math.max(last.end, o.end);
    else spans.push({ start: o.start, end: o.end });
  }
  const covered = (h) => {
    let lo = 0, hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (spans[mid].start > h.start) hi = mid - 1;
      else if (spans[mid].end < h.start) lo = mid + 1;
      else return h.end <= spans[mid].end;
    }
    return false;
  };
  for (const h of passHits(view)) if (!covered(h)) yield h;
}

function* passHits(view) {
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (const m of view.matchAll(d.re)) {
      let g = d.group;
      let bare = false;
      if (g && m.groups?.[g] === undefined && d.alt && m.groups?.[d.alt] !== undefined) { g = d.alt; bare = true; }
      const value = g ? m.groups?.[g] : m[0];
      if (value === undefined) continue;
      const [start, end] = g ? m.indices.groups[g] : m.indices[0];
      if (g && !isRealValue(value, { min: d.min ?? 4, rule: d.name, key: m.groups?.k ?? '' })) continue;
      if (d.check && !d.check(value, bare, m)) continue;
      yield { rule: d.name, start, end };
    }
  }
}

/** Strict detection: every literal secret-shaped value, with offsets (never the value itself). */
export function findSecrets(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [...hits(text)].sort((a, b) => a.start - b.start);
  // Line numbers counted in one forward pass: a split per hit is quadratic on a big text with many hits.
  let line = 1;
  let next = text.indexOf('\n');
  for (const h of out) {
    while (next !== -1 && next < h.start) { line++; next = text.indexOf('\n', next + 1); }
    h.line = line;
  }
  return out;
}

// ------------------------------------------------------------ redaction only

function netKeeps(key, raw) {
  const v = clean(raw);
  return PLACEHOLDER.test(v) || /^\[[A-Z_]+\]/.test(v) || (NUMERIC.test(v) && /tokens(?![a-z])/i.test(key)) ||
    CODE_REF.test(v) || (IDENT_REF.test(v) && SECRET_WORD.test(v)) || describesSecret(key);
}

const RULES = [
  // key=value / key: value assignments for secret-ish names (audit-era rule, broader than the detectors on purpose:
  // it is the net under them). It lets through only the false positives seen: `author…` keys, placeholders, a number
  // under an LLM token counter (`max_tokens=4096`), a call or member access, a key describing a secret.
  [
    /\b((?:[A-Za-z_]{0,64}(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth(?:orization|(?!or)))[A-Za-z_]{0,64}))(\s*[:=]\s*)(["']?)([^\s"',;)]{4,})\3/gi,
    (m, key, sep, q, v) => (netKeeps(key, v) ? m : `${key}${sep}${q}[REDACTED]${q}`),
  ],
  // One-time codes stated next to the word.
  [/(?<!\p{L})(otp|одноразов\p{L}*|код подтверждения|verification code|2fa)(?!\p{L})([^\n]{0,20}?)\b\d{4,8}\b/giu, '$1$2 [OTP]'],
];

/** Redact secrets from a string. Returns the cleaned string. */
export function scrub(text) {
  if (typeof text !== 'string' || !text) return text;
  // Detector hits first. Overlaps merge.
  const spans = [...hits(text)].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) { last.end = Math.max(last.end, s.end); continue; }
    merged.push({ ...s });
  }
  // Assembled in one forward pass: a splice per span re-copies the whole text each time.
  const parts = [];
  let at = 0;
  for (const { start, end, rule } of merged) {
    parts.push(text.slice(at, start), rule === 'private-key' ? '[PRIVATE_KEY]' : rule === 'hex-blob' ? '[HEX_BLOB]' : '[REDACTED]');
    at = end;
  }
  parts.push(text.slice(at));
  let out = parts.join('');
  for (const [re, repl] of RULES) out = out.replace(re, repl);
  return out;
}

// A token is far shorter than this; a window this much longer than the kept part holds any token the cut crosses whole.
const CUT_MARGIN = 4000;

/** The first `n` characters of `text`, scrubbed before the cut. */
export function scrubHead(text, n) {
  if (typeof text !== 'string' || text.length <= n) return scrub(text);
  return scrub(text.slice(0, n + CUT_MARGIN)).slice(0, n);
}

/** The last `n` characters of `text`, scrubbed before the cut. */
export function scrubTail(text, n) {
  if (typeof text !== 'string' || text.length <= n) return scrub(text);
  return scrub(text.slice(-(n + CUT_MARGIN))).slice(-n);
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
