// Pure redaction engine: no `$`, no I/O. register.ts feeds it known values and
// runs it over every string the model would read.
//
// A replaced value becomes ‹secret:NAME#nonce›: NAME is the variable when the
// value came from a file or a key name, else the kind of token; the nonce marks
// it as one this mod produced, so text ABOUT placeholders (tests, docs, grep)
// is never mistaken for one. Names, listings and structure stay visible.

export type Secret = { readonly name: string; readonly value: string }

export type Index = {
  /** One alternation over every known value, longest first; null when none. */
  readonly known: RegExp | null
  readonly byValue: ReadonlyMap<string, string>
  readonly size: number
}

export const MARK = '‹secret:'

let nonce = '0000'
/** The nonce every placeholder carries; register.ts sets it from HOME, so it is the same in every session and resume. */
export function setNonce(n: string): void {
  if (/^[0-9a-f]{4}$/.test(n)) nonce = n
}
export const currentNonce = (): string => nonce
/** Four hex digits from a seed (FNV-1a): stable for a user, not a secret. */
export function nonceFor(seed: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return ((h ^ (h >>> 16)) & 0xffff).toString(16).padStart(4, '0')
}
/** Whitespace and the closing mark leave the name, so `hasPlaceholder` reads back every placeholder this mod writes. */
export const placeholderName = (name: string): string => name.replace(/[\s›]+/g, '_').slice(0, 120) || 'secret'
export const placeholder = (name: string): string => `${MARK}${placeholderName(name)}#${nonce}›`
export const EMPTY_INDEX: Index = { known: null, byValue: new Map(), size: 0 }

// ---------------------------------------------------------------------------
// What a secret NAME looks like
// ---------------------------------------------------------------------------

/** Segments that qualify a name without changing what it holds (API_KEY_PROD, TOKEN_2, secretValue). */
const QUALIFIERS = new Set([
  'value', 'val', 'base', 'b64', 'base64', 'enc', 'encrypted', 'raw', 'plain', 'str', 'string', 'text',
  'prod', 'production', 'dev', 'development', 'test', 'testing', 'staging', 'stage', 'live', 'old', 'new',
  'local', 'data', 'hex', 'current', 'prev', 'previous', 'primary', 'secondary', 'main', 'default', 'override',
])

/** A last segment that alone makes the name secret, in any casing. */
const SECRET_LAST = new Set([
  'password', 'passwd', 'pass', 'passphrase', 'passcode', 'secret', 'secrets', 'token',
  'credential', 'credentials', 'cred', 'creds', 'dsn', 'cookie', 'cookies', 'authorization',
  'apikey', 'apitoken', 'apisecret', 'apihash', 'secretkey', 'accesskey', 'privatekey', 'clientsecret',
  'authtoken', 'authkey', 'sessionkey', 'connstr', 'connectionstring', 'databaseurl', 'apppassword',
  'appsecret', 'accesstoken', 'refreshtoken', 'bearertoken',
])

/** A last segment that makes the name secret only in an UPPER_SNAKE name of 2+ segments (DB_PWD, SSH_KEY, BASIC_AUTH). */
const SECRET_LAST_UPPER = new Set(['pwd', 'key', 'auth', 'salt', 'pat'])

/** What may stand before KEY without it being a credential (CACHE_KEY, PUBLIC_KEY, SORT_KEY). */
const KEY_BENIGN = new Set([
  'public', 'primary', 'sort', 'cache', 'partition', 'foreign', 'i18n', 'translation', 'idempotency',
  'storage', 'redis', 'map', 'index', 'unique', 'object', 'row', 'group', 'routing', 'lookup', 'dedup',
  'cursor', 'react', 'hash', 'cluster', 'shard', 'local', 'session_storage', 's3', 'bucket', 'prefix',
])

/** In an UPPER_SNAKE name, a word that makes it secret anywhere (SHOP_PROD_PASSWORD_ACME, GITHUB_TOKEN_RW)… */
const SECRET_INNER = new Set(['password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'credentials'])
/** …unless a word after it says the variable holds something about the secret, not the secret (PASSWORD_RESET_URL, TOKEN_TTL). */
const ABOUT_SECRET = new Set([
  'url', 'uri', 'path', 'file', 'dir', 'endpoint', 'expiry', 'expires', 'expiration', 'ttl', 'timeout', 'lifetime',
  'type', 'name', 'names', 'length', 'len', 'size', 'min', 'max', 'count', 'header', 'field', 'param', 'policy',
  'regex', 'pattern', 'mode', 'enabled', 'required', 'rotation', 'reset', 'id', 'label', 'prefix', 'version', 'env',
])

/** A glued last segment ending in a secret word (PGPASSWORD, GITHUBTOKEN, HTPASSWD, csrftoken), any casing. */
const GLUED_SECRET = /^[a-z0-9]{2,}(password|passwd|passphrase|secret|token)$/
/** The same in an UPPER name only, where the word is not an English one (SSHPASS, MYSQLPWD, PROXYAUTH, APPKEY). */
const GLUED_SECRET_UPPER = /^[a-z0-9]{2,}(pass|pwd|auth)$|^(api|secret|access|private|auth|session|signing|encryption|master|license|client|app|service|account|deploy|ssh|gpg|jwt)key$/

/** Two last segments that together make the name secret. */
const SECRET_PAIRS = new Set([
  'api_key', 'api_hash', 'api_token', 'api_secret', 'private_key', 'access_key', 'secret_key',
  'client_secret', 'client_key', 'auth_key', 'auth_token', 'database_url', 'db_url', 'db_dsn',
  'conn_str', 'conn_string', 'connection_string', 'connection_str', 'connection_url', 'app_password',
  'app_secret', 'app_key', 'session_key', 'session_secret', 'signing_key', 'signing_secret',
  'encryption_key', 'master_key', 'account_key', 'service_key', 'ssh_key', 'gpg_key', 'deploy_key',
  'license_key', 'consumer_key', 'consumer_secret', 'webhook_secret', 'private_token', 'basic_auth',
  'http_auth', 'proxy_auth', 'id_token', 'jwt_key',
])

function segments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Does this variable / key / header / flag name hold a credential? */
export function isSecretName(name: string): boolean {
  const segs = segments(name)
  while (segs.length > 1 && (QUALIFIERS.has(segs[segs.length - 1]!) || /^\d+$/.test(segs[segs.length - 1]!))) segs.pop()
  const last = segs[segs.length - 1]
  if (last === undefined) return false
  // `pass` alone is a word in prose and code (one pass, pass = 0); PASS, DB_PASS, smtpPass are names.
  if (last === 'pass' && segs.length === 1 && name !== 'PASS') return false
  if (SECRET_LAST.has(last)) return true
  const isUpper = /^[A-Z0-9_]+$/.test(name) && /[A-Z]/.test(name)
  if (GLUED_SECRET.test(last) || (isUpper && GLUED_SECRET_UPPER.test(last))) return true
  if (segs.length >= 2) {
    const prev = segs[segs.length - 2]!
    if (SECRET_PAIRS.has(`${prev}_${last}`)) return true
    if (isUpper && SECRET_LAST_UPPER.has(last) && !(last === 'key' && KEY_BENIGN.has(prev))) return true
    if (isUpper) {
      const at = segs.findIndex(x => SECRET_INNER.has(x))
      if (at >= 0 && !segs.slice(at + 1).some(x => ABOUT_SECRET.has(x))) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// What a literal secret VALUE looks like (and what is a placeholder, a type,
// a reference or an expression instead)
// ---------------------------------------------------------------------------

/** Words that stand where a value would and are not one: types, keywords, placeholders. */
const NOT_VALUES = new Set([
  'string', 'number', 'boolean', 'bool', 'int', 'integer', 'float', 'double', 'bigint', 'symbol', 'object',
  'any', 'unknown', 'never', 'void', 'undefined', 'null', 'nil', 'none', 'true', 'false', 'yes', 'no', 'on',
  'off', 'required', 'optional', 'function', 'str', 'bytes', 'char', 'text', 'varchar', 'uuid', 'date',
  'datetime', 'timestamp', 'json', 'jsonb', 'secret', 'secrets', 'password', 'passwd', 'token', 'apikey',
  'api_key', 'changeme', 'change_me', 'change-me', 'changeit', 'placeholder', 'example', 'sample', 'dummy',
  'fake', 'test', 'testing', 'redacted', 'hidden', 'masked', 'removed', 'omitted', 'todo', 'tbd', 'fixme',
  'empty', 'default', 'include', 'omit', 'same-origin', 'bearer', 'basic', 'sensitive', 'notset', 'not-set',
  'unset', 'value', 'n/a', 'secretstr', 'secretstring', 'password_hash', 'hashed',
])

/** Values too common to hide by exact match without destroying unrelated output. */
const COMMON_VALUES = new Set([
  'localhost', 'postgres', 'postgresql', 'mysql', 'mariadb', 'redis', 'mongodb', 'production', 'development',
  'staging', 'testing', 'administrator', 'password', 'password1', 'password123', 'default', 'example',
  'changeme', 'docker', 'latest', 'enabled', 'disabled', 'en_us.utf-8', 'utf-8', 'undefined', 'anonymous',
  'qwerty123', 'secret123', '12345678', 'abcdefgh',
])

const PLACEHOLDER_RES: readonly RegExp[] = [
  /^(your|my|insert|enter|replace|put|add|paste|set)([-_ ]?(own|real|actual|new))?[-_ ][a-z0-9_ -]*$/i,
  /^<[^<>]*>$/,
  /^\[[^\]]*\]$/,
  /^\{\{.*\}\}$/,
  /^\$\{\{.*\}\}$/,
  /^%[a-z(]/i,
  /^[x*.•#_-]+$/i,
  /^(\.\.\.|…)$/,
  /x{4,}/i,
  /\*{3,}/,
  /(example|placeholder|changeme|change[-_]me|dummy|redacted|replace[-_]?me|your[-_](api|secret|token|password|key))/i,
]

export function isPlaceholder(value: string): boolean {
  const v = value.trim()
  if (v === '') return true
  if (NOT_VALUES.has(v.toLowerCase())) return true
  return PLACEHOLDER_RES.some(re => re.test(v))
}

/** A reference or expression in code / config, not a literal value. */
function isReference(v: string): boolean {
  if (v.includes(MARK)) return true
  if (/^[$%@!&*]/.test(v)) return true // $VAR ${..} $(..) %VAR% @Ref !Ref &anchor *alias
  if (/\$\{|\$\(|\{\{|<%|%>|`/.test(v)) return true
  if (/\b(process\.env|import\.meta\.env|os\.environ|getenv|Deno\.env|ENV\[|System\.getenv|env\()/.test(v)) return true
  return false
}

const TYPE_UNION = /^[A-Za-z_][\w.<>[\]]*(\s*[|&]\s*[A-Za-z_][\w.<>[\]]*)*$/
const IS_TYPEWORD = (w: string) => NOT_VALUES.has(w.toLowerCase()) || /^[A-Z][a-z]+([A-Z][a-z]+)*(\[\])?$/.test(w)

/**
 * The part of a raw assignment value to hide, or null to leave it.
 *
 * `quoted`: the value was a quoted literal (code or JSON); `upperName`: the key
 * is an env-style UPPER_SNAKE name (dotenv, env dump), where an unquoted value
 * is always a literal; `eol`: the unquoted value ran to the end of the line
 * (YAML, dotenv), so spaces are allowed and code punctuation means code.
 */
export function valueToHide(raw: string, ctx: { quoted: boolean; upperName: boolean; eol: boolean; minLen?: number }): string | null {
  let v = raw
  if (!ctx.quoted) {
    // a to-end-of-line value that runs into a JSON line (`pw","user":"x"`) ends where the next key begins
    if (ctx.eol) {
      const tail = v.search(/"\s*,\s*"[A-Za-z_$][\w$.-]*"\s*:/)
      if (tail > 0) v = v.slice(0, tail)
    }
    v = v.replace(/\s+#.*$/, '').trim().replace(/[;,]+['"`)\]]*[;,]*$/, '').trim()
    if (/^[A-Za-z]+[.:!?]$/.test(v)) v = v.slice(0, -1) // a word ending a sentence in prose (--api-key=value.)
  }
  if (v.length < (ctx.minLen ?? 6)) return null
  if (/^[\d_]+(\.\d+)?$/.test(v)) return null
  // A value that is itself a credential NAME is a label or a reference (session_key=session_key, ? 'cookie' : 'authorization').
  if (/^([a-z][a-z0-9]*(_[a-z0-9]+)*|[a-z]+([A-Z][a-z0-9]*)+|[A-Z][A-Z0-9]*(_[A-Z0-9]+)*)$/.test(v) && isSecretName(v)) return null
  // Lowercase words joined by _ or - (user_typed, same-origin) are labels in code; a dotenv value stays a literal.
  if (!ctx.upperName && /^[a-z]+([_-][a-z]+)+$/.test(v)) return null
  if (isReference(v) || isPlaceholder(v)) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return null // URLs: the URL rule hides only their password
  if (/^(\/|~\/|\.\.?\/)([\w.@-]+\/)*[\w.@-]*$/.test(v)) return null // a path (PGPASSFILE, htpasswd: /etc/nginx/.htpasswd)
  if (!ctx.quoted) {
    if (/^[|>][-+]?$/.test(v)) return null // YAML block scalar indicator
    if (/^[[{(]/.test(v)) return null
    if (/[(){}[\]<>]|=>|\s=\s|\s(\|\||&&|\?\?)\s/.test(v)) return null // code
    if (TYPE_UNION.test(v) && v.split(/\s*[|&]\s*/).every(IS_TYPEWORD)) return null
    if (!ctx.upperName) {
      if (/^(new|await|this|self|typeof|function|return|async|lambda)\b/.test(v)) return null
      if (/^[A-Za-z_$][\w$]*(\.[\w$]+)+$/.test(v)) return null // member access
      if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(v)) return null // camelCase identifier
      if (/^[a-z_][a-z0-9_]*$/.test(v) && v.includes('_') && segments(v).some(s => SECRET_LAST.has(s) || s === 'key')) return null // db_password
      if (/^[A-Z][a-z]+([A-Z][a-z]+)*$/.test(v)) return null // PascalCase type
    }
    if (ctx.eol && /\s/.test(v) && !ctx.upperName && /^\w+\s+\w+\s+\w+\s+\w+/.test(v) && /^[a-z ]+$/i.test(v) && v.length > 40) return null // prose
  }
  return v
}

/** A value that stands for no value at all: a type, a keyword, a common default, a template slot. */
function isExactPlaceholder(v: string): boolean {
  const l = v.toLowerCase()
  if (NOT_VALUES.has(l) || COMMON_VALUES.has(l)) return true
  // template slots only (your-api-key, sk-xxxx…, ***): a value that merely reads like a phrase (add-my-key-2024) still counts
  return /^<[^<>]*>$|^\[[^\]]*\]$|^\{\{.*\}\}$|^\$\{\{.*\}\}$|^%[a-z(]|^[x*.•#_-]+$|^(\.\.\.|…)$|^your[-_ ]|x{4,}|\*{3,}/i.test(v)
}

/**
 * Is a value under a secret NAME (DB_PASSWORD=…) worth hiding everywhere it
 * appears? Whatever its shape: a lowercase word, digits, a short or spaced or
 * dotted one, one that looks like a placeholder; only a reference, an exact
 * placeholder token or a common default is not.
 */
export function isSecretValue(value: string): boolean {
  const v = value.trim()
  if (v.length < 6 || v.length > 8192) return false
  if (/^(\/|~\/|\.\.?\/|[A-Za-z]:\\)\S*$/.test(v)) return false // a path to the secret (GOOGLE_APPLICATION_CREDENTIALS), not the secret
  return !isExactPlaceholder(v) && !isReference(v)
}

/** Is a value from a file worth hiding everywhere it appears (known value)? */
export function isKnownCandidate(value: string, secretName: boolean): boolean {
  const v = value.trim()
  if (v.length < 8 || v.length > 8192) return false
  if (/^\d+$/.test(v)) return false
  // a JSON key inside (`x","n":3`) is a rule's overreach into the line, never a value worth hiding everywhere
  if (/"[A-Za-z_$][\w$.-]*"\s*:/.test(v)) return false
  if (/\s/.test(v) && !/^[a-z]{4}( [a-z]{4}){3}$/.test(v)) return false
  if (isPlaceholder(v) || isReference(v) || COMMON_VALUES.has(v.toLowerCase())) return false
  if (/^(\/|~\/|\.\.?\/|[A-Za-z]:\\)/.test(v)) return false // paths
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false // URLs: register their parts instead
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v)) return false // e-mail
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(v)) return false // IP
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?$/i.test(v)) return false // hostname
  if (/^v?\d+(\.\d+)+[a-z0-9-]*$/i.test(v)) return false // version
  const classes = Number(/[a-z]/.test(v)) + Number(/[A-Z]/.test(v)) + Number(/\d/.test(v)) + Number(/[^A-Za-z0-9._\-/ ]/.test(v))
  if (secretName) return classes >= 2 || v.length >= 16
  // Under a name that does not look secret only a random-looking value counts.
  if (v.length < 16) return false
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return false
  if (v.includes('/') && !/^[A-Za-z0-9+/=]{24,}$/.test(v)) return false
  if (/^[a-z]+([_.-][a-z]+)*$/i.test(v)) return false
  return /\d/.test(v) && /[A-Za-z]/.test(v) && classes >= 2
}

// ---------------------------------------------------------------------------
// Known values → one regex
// ---------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * A known value as a regex alternative. A short or one-class value (`mailer`, `shopco`) also lives inside ordinary
 * words and paths, so it is matched only where no letter or digit touches it.
 */
export function valueAlt(value: string, fragment = false): string {
  if (fragment) return escapeRe(value)
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(value)).length
  const e = escapeRe(value)
  return value.length < 12 || classes < 2 ? `(?<![A-Za-z0-9])${e}(?![A-Za-z0-9])` : e
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function utf8(s: string): number[] {
  const out: number[] = []
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

/**
 * The base64 text of `value` as it appears inside a longer encoded stream, at
 * each of the three byte alignments: only the characters that depend on the
 * value's bytes alone. An encoded dotenv file or secret blob then shows
 * placeholders where the known values sat.
 */
export function base64Cores(value: string): string[] {
  const bytes = utf8(value)
  const cores: string[] = []
  for (const k of [0, 1, 2]) {
    const all = [...new Array<number>(k).fill(0), ...bytes]
    let bits = 0
    let acc = 0
    let text = ''
    for (const b of all) {
      acc = (acc << 8) | b
      bits += 8
      while (bits >= 6) {
        bits -= 6
        text += B64[(acc >> bits) & 63]
        acc &= (1 << bits) - 1
      }
    }
    const core = text.slice(Math.ceil((k * 8) / 6))
    if (core.length >= 6) cores.push(core)
  }
  return cores
}

/**
 * The forms a value takes inside other formats: JSON string escapes (also
 * PHP's `\/` and ensure_ascii `\uXXXX`), HTML/XML entities, URL encoding.
 * Only the forms that differ from the value itself.
 */
export function encodedForms(value: string): string[] {
  const out = new Set<string>()
  const json = JSON.stringify(value).slice(1, -1)
  const ascii = json.replace(/[\u0080-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
  for (const j of [json, ascii, ascii.replace(/\\u([0-9a-f]{4})/g, (_m, h: string) => '\\u' + h.toUpperCase())]) {
    out.add(j)
    out.add(j.replace(/\//g, '\\/'))
  }
  const text = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  out.add(text)
  out.add(text.replace(/"/g, '&quot;').replace(/'/g, '&#39;'))
  out.add(text.replace(/"/g, '&quot;').replace(/'/g, '&#x27;'))
  try {
    const url = encodeURIComponent(value)
    out.add(url)
    out.add(url.replace(/%20/g, '+'))
    out.add(url.replace(/%2F/g, '/'))
  } catch {
    // a lone surrogate has no URL form
  }
  out.delete(value)
  return [...out].filter(f => f.length >= 6)
}

/** Builds the known-value index; the first secret-looking name wins for a value. */
export function buildIndex(secrets: readonly Secret[]): Index {
  const byValue = new Map<string, string>()
  // base64 cores sit inside a longer blob by nature, so they match glued to letters
  const fragments = new Set<string>()
  const put = (value: string, name: string) => {
    const prior = byValue.get(value)
    if (prior === undefined || (!isSecretName(prior) && isSecretName(name))) byValue.set(value, name)
  }
  for (const s of secrets) put(s.value, s.name)
  const plain = byValue.size
  for (const s of secrets) {
    for (const form of encodedForms(s.value)) if (!byValue.has(form)) put(form, s.name)
    for (const core of base64Cores(s.value)) {
      if (!byValue.has(core)) {
        put(core, s.name)
        fragments.add(core)
      }
      const url = core.replace(/\+/g, '-').replace(/\//g, '_')
      if (url !== core && !byValue.has(url)) {
        put(url, s.name)
        fragments.add(url)
      }
    }
  }
  if (byValue.size === 0) return EMPTY_INDEX
  const values = [...byValue.keys()].sort((a, b) => b.length - a.length)
  return { known: new RegExp(values.map(v => valueAlt(v, fragments.has(v))).join('|'), 'g'), byValue, size: plain }
}

/** A stable string over the set, to rebuild the regex only when it changed. */
export function signatureOf(secrets: readonly Secret[]): string {
  return secrets.map(s => `${s.name}\u0001${s.value}`).sort().join('\u0002')
}

// ---------------------------------------------------------------------------
// Rules over text
// ---------------------------------------------------------------------------

const PEM_RE = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(?:-----END \1PRIVATE KEY\2-----|$)/g

type Shape = readonly [kind: string, re: RegExp, check?: (m: string) => boolean]

/** Token shapes, most specific first (sk-ant- before sk-). */
const SHAPES: readonly Shape[] = [
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['notion-token', /\b(?:ntn_[A-Za-z0-9]{40,}|secret_[A-Za-z0-9]{43})\b/g],
  ['anthropic-key', /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-|or-v1-)?[A-Za-z0-9_-]{20,}/g, m => /\d/.test(m) && (/[A-Z]/.test(m) || m.length >= 40)],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['stripe-key', /\b(?:[sr]k_live_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{20,})\b/g],
  ['telegram-bot-token', /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{34,}\b/g],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g],
  ['digitalocean-token', /\bdo[opr]_v1_[a-f0-9]{64}\b/g],
  ['age-key', /\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b/g],
]

function applyShapes(t: string): string {
  for (const [kind, re, check] of SHAPES) t = t.replace(re, m => (check && !check(m) ? m : placeholder(kind)))
  return t
}

const URL_CRED_RE = /\b([a-z][a-z0-9+.-]{1,30}:\/\/)([^\s:/?#@'"`<>]*):([^\s/?#'"`<>]+)@(?=[^\s@'"`<>]*[A-Za-z0-9])/gi
const WEBHOOK_RES: readonly (readonly [string, RegExp])[] = [
  ['slack-webhook', /(https:\/\/hooks\.slack\.com\/services\/)([A-Za-z0-9_/]{10,})/g],
  ['discord-webhook', /(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)([A-Za-z0-9_-]{20,})/g],
]

function redactUrls(t: string): string {
  if (t.includes('://')) {
    t = t.replace(URL_CRED_RE, (m, scheme: string, user: string, pass: string) =>
      isPlaceholder(pass) || isReference(pass) || pass.length < 3 || /^(pass|pwd|pw|passw(or)?d|secret|token|user|pass(word)?\d?)$/i.test(pass)
        ? m
        : (note(pass, 'url-password'), `${scheme}${user}:${placeholder('url-password')}@`))
    for (const [kind, re] of WEBHOOK_RES) t = t.replace(re, (_m, head: string) => `${head}${placeholder(kind)}`)
  }
  return t
}

/** Headers anywhere (curl -v, a quoted -H argument, HTTP dumps): hide the credential, keep the scheme. */
const HEADER_RE = /(?<=^|[\n\0>=]|^[ \t]+|\n[ \t]+|[<>][ \t]|-H[ \t]*["']?|--header[= \t]["']?|["'])(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|private-token|x-gitlab-token|x-goog-api-key|x-figma-token|x-notion-token|cookie|set-cookie)(["']?\s*:\s*["']?)((?:bearer|basic|token|digest|bot|negotiate|ntlm|dsn)\s+)?([^\s'"\\,;]+)/gi

function redactHeaders(t: string): string {
  return t.replace(HEADER_RE, (m, name: string, sep: string, scheme: string | undefined, val: string) => {
    if (val.length < 6 || valueToHide(val, { quoted: false, upperName: false, eol: false }) === null) return m
    const kind = /cookie/i.test(name) ? 'cookie' : name.toLowerCase()
    note(val, kind)
    return `${name}${sep}${scheme ?? ''}${placeholder(kind)}`
  })
}

/**
 * Lines of a dotenv file / env dump / export statement: NAME=value to the end of the line;
 * also the spaced `name = value` of INI / TOML / HCL / Makefiles (~/.aws/credentials, my.cnf,
 * .pypirc, rclone.conf, *.tfvars), where code on the right side is left by valueToHide.
 * A line may carry grep's `path:12:` / `12:` prefix, a diff's `+`/`-` or a list's `- `.
 */
const EQ_LINE_RE = /(^|[\n\0])((?:[^\s:\n\0]{1,300}:(?:\d{1,7}[:-])?|\d{1,7}[:-])?[ \t]*(?:[+>-][ \t]*)?(?:export[ \t]+|declare[ \t]+-x[ \t]+|setenv[ \t]+)?)([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*=(?!=)[ \t]*)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\n\0]*)/g
/**
 * NAME=value inside a line: query strings, container Env arrays, ps output, .npmrc `//host/:_authToken=`.
 * No name character may stand before NAME (`-` is one), so a long run of
 * name characters is tried from one start, not from each of its characters.
 */
const EQ_INLINE_RE = /([\s"'`{(\[,;&?|:+])([A-Za-z_][A-Za-z0-9_.-]*)=("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s"'`&;,)\]}|]+)/g
/** "NAME=value" as one JSON / shell string (container Env, `-e "X=y"`): the value runs to the closing quote, escapes and all. */
const ENV_STR_RE = /"([A-Za-z_][A-Za-z0-9_]*)=((?:[^"\\\n]|\\.)*)"/g
/** "name": "value", 'name': 'value', 'name' => 'value' (JSON, Python dicts, PHP arrays). */
const JSON_PAIR_RE = /(["'])([A-Za-z_][A-Za-z0-9_. -]{0,60}?)\1(\s*(?::|=>)\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g
/** Ruby's :name => 'value'. */
const RUBY_SYM_RE = /(?<![\w:]):([A-Za-z_]\w{0,60})(\s*=>\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g
/** define('DB_PASSWORD', 'x'), getenv('API_KEY', 'default'), ENV.fetch('TOKEN', 'x'). */
const CALL_DEFAULT_RE = /\b(define|getenv|env|os\.getenv|os\.environ\.get|environ\.get|ENV\.fetch|config)(\s*\(\s*)(["'])([A-Za-z_][\w.]{0,80})\3(\s*,\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g
/** <password>x</password>, <ns:token>x</ns:token>. */
const XML_ELEM_RE = /<((?:[A-Za-z_][\w.-]{0,60}:)?([A-Za-z_][\w.-]{0,60}))(\s[^<>]{0,300})?>([^<>\n]{1,500})<\/\1>/g
/** <add key="DB_PASSWORD" value="x"/>, <property name="password" value="x"/>. */
const XML_KV_RE = /\b((?:key|name)=)(["'])([^"'<>]{1,80})\2(\s+value=)(["'])([^"'<>]{1,500})\5/g
/** <entry key="db.password">x</entry>. */
const XML_ENTRY_RE = /<([A-Za-z_][\w.-]{0,40})(\s+(?:key|name)=)(["'])([^"'<>]{1,80})\3([^<>]{0,200})>([^<>\n]{1,500})<\/\1>/g
/** name: value (YAML, JS object literals, headers at line start). */
const COLON_RE = /(^|[\s{,(])([A-Za-z_][A-Za-z0-9_.-]*)([?!]?[ \t]*:[ \t]*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\n]*)/g
/** --password value, --api-key=value. */
const FLAG_RE = /(^|\s)(--?[A-Za-z][A-Za-z0-9_-]*)(=|[ \t]+)("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s"'`;&|]+)/g

/**
 * Short password flags of known CLIs, read per command segment (split at
 * newline, `|`, `;`, `&`): [the CLI, a word the segment must also hold, the
 * flag with the text kept before the value as group 1 and the value as group 2].
 */
type CliRule = readonly [kind: string, cli: RegExp, need: RegExp | null, flag: RegExp]
const CLI_RULES: readonly CliRule[] = [
  ['mysql-password', /\b(?:mysql|mariadb|mysqldump|mysqladmin|mariadb-dump|mysqlimport|mysqlshow|mysqlcheck|mysqlpump)\b/, null, /(?<=\s)(-p)([^\s'"]{4,})/g],
  ['sshpass-password', /\bsshpass\b/, null, /(?<=\s)(-p[ \t]*['"]?)([^\s'"]{4,})/g],
  ['registry-password', /\b(?:docker|podman|nerdctl|buildah|skopeo|helm|oras|crane)\b/, /\blogin\b/, /(?<=\s)(-p[ \t]+['"]?)([^\s'"]{4,})/g],
  ['redis-password', /\bredis-cli\b/, null, /(?<=\s)(-a[ \t]+['"]?)([^\s'"]{4,})/g],
  ['ldap-password', /\bldap(?:search|modify|add|delete|whoami|passwd|compare|modrdn)\b/, null, /(?<=\s)(-w[ \t]+['"]?)([^\s'"]{4,})/g],
  ['mongo-password', /\bmongo(?:sh|dump|restore|export|import|stat|top|files)?\b/, null, /(?<=\s)(-p[ \t]+['"]?)([^\s'"]{4,})/g],
  ['zip-password', /\b(?:zip|unzip|zipcloak)\b/, null, /(?<=\s)(-P[ \t]+['"]?)([^\s'"]{4,})/g],
  ['archive-password', /\b(?:7z|7za|7zr|rar|unrar)\b/, null, /(?<=\s)(-p)([^\s'"]{4,})/g],
  ['openssl-password', /\bopenssl\b/, null, /(?<=\s)(-pass(?:in|out)?[ \t]+['"]?pass:|-k[ \t]+['"]?)([^\s'"]{4,})/g],
  ['curl-password', /\bcurl\b/, null, /(?<=\s)((?:-u|--user)[ \t=]*['"]?[^\s'":]+:)([^\s'"]{4,})/g],
  ['smb-password', /\bsmbclient\b/, null, /(?<=\s)((?:-U|--user)[ \t=]*['"]?[^\s'"%]+%)([^\s'"]{4,})/g],
  ['mssql-password', /\b(?:sqlcmd|bcp)\b/, null, /(?<=\s)(-P[ \t]*['"]?)([^\s'"]{4,})/g],
  ['htpasswd-password', /\bhtpasswd\b/, null, /(?<=\s)(-[A-Za-z]*b[A-Za-z]*[ \t]+\S+[ \t]+\S+[ \t]+['"]?)([^\s'"]{4,})/g],
]
const CLI_ANY = /\b(?:mysql\w*|mariadb\w*|sshpass|docker|podman|nerdctl|buildah|skopeo|helm|oras|crane|redis-cli|ldap\w+|mongo\w*|zip|unzip|zipcloak|7z\w?|rar|unrar|openssl|curl|smbclient|sqlcmd|bcp|htpasswd)\b/

/** Linear: one split, then per segment one pass of each matching CLI's flag rule over the text after the CLI word. */
function redactCliFlags(t: string): string {
  if (!CLI_ANY.test(t)) return t
  const parts = t.split(/([\n|;&])/)
  let changed = false
  for (let i = 0; i < parts.length; i += 2) {
    const seg = parts[i]!
    if (seg.length < 8 || !CLI_ANY.test(seg)) continue
    let out = seg
    for (const [kind, cli, need, flag] of CLI_RULES) {
      const m = cli.exec(out)
      if (!m || (need && !need.test(out))) continue
      const at = m.index + m[0].length
      const tail = out.slice(at)
      const next = tail.replace(flag, (whole, head: string, val: string) =>
        val.startsWith(MARK) || isReference(val) || isPlaceholder(val) ? whole : (note(val, kind), `${head}${placeholder(kind)}`))
      if (next !== tail) out = out.slice(0, at) + next
    }
    if (out !== seg) {
      parts[i] = out
      changed = true
    }
  }
  return changed ? parts.join('') : t
}

/** Hides a quoted literal's value under a secret name, keeping the quotes. */
function hideQuoted(m: string, name: string, raw: string, head: string): string {
  if (!isSecretName(name)) return m
  const [inner] = unquote(raw)
  const core = valueToHide(inner, { quoted: true, upperName: isUpperName(name), eol: false })
  return core === null ? m : `${head}${swap(raw, core, name)}`
}

/** XML elements and attributes holding a credential. */
function redactXml(t: string): string {
  if (!t.includes('</') && !t.includes('/>')) return t
  t = t.replace(XML_ELEM_RE, (m, tag: string, local: string, attrs: string | undefined, inner: string) => {
    if (!isSecretName(local)) return m
    const core = valueToHide(inner, { quoted: true, upperName: false, eol: false })
    return core === null ? m : `<${tag}${attrs ?? ''}>${swap(inner, core, local)}</${tag}>`
  })
  t = t.replace(XML_KV_RE, (m, k: string, q1: string, name: string, v: string, q2: string, inner: string) => {
    if (!isSecretName(name)) return m
    const core = valueToHide(inner, { quoted: true, upperName: isUpperName(name), eol: false })
    return core === null ? m : `${k}${q1}${name}${q1}${v}${q2}${swap(inner, core, name)}${q2}`
  })
  t = t.replace(XML_ENTRY_RE, (m, tag: string, k: string, q: string, name: string, rest: string, inner: string) => {
    if (!isSecretName(name)) return m
    const core = valueToHide(inner, { quoted: true, upperName: isUpperName(name), eol: false })
    return core === null ? m : `<${tag}${k}${q}${name}${q}${rest}>${swap(inner, core, name)}</${tag}>`
  })
  return t
}

const unquote = (v: string): [inner: string, q: string] =>
  (v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ? [v.slice(1, -1), v[0]!]
    : [v, '']

const isUpperName = (n: string) => /^[A-Z][A-Z0-9_]*$/.test(n) && n.includes('_') || /^[A-Z]{3,}$/.test(n)

/** Values the rules hid during the current redactText pass: every other occurrence goes too. */
let collector: Map<string, string> | null = null
/**
 * Records a value a rule hid, so its other occurrences in the same text are
 * hidden as well; only a password-like one (8+ characters, two kinds of
 * characters or 16+): spreading a word would turn one rule miss into many.
 */
const note = (value: string, name: string): void => {
  if (collector !== null && !value.startsWith(MARK) && isKnownCandidate(value, true)) collector.set(value, name)
}

/** Replaces `core` inside `raw` (first occurrence), keeping quotes, comments and trailing punctuation. */
const swap = (raw: string, core: string, name: string) => {
  note(core, name)
  const at = raw.indexOf(core)
  return at < 0 ? raw : raw.slice(0, at) + placeholder(name) + raw.slice(at + core.length)
}

/** URL-valued secret names: hide only a user-only userinfo (Sentry DSN key); a user:pass@ is the URL rule's. */
function urlUserinfo(v: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^\s:/?#@]+)@/i.exec(v)
  return m && m[1]!.length >= 16 && /\d/.test(m[1]!) && /[A-Za-z]/.test(m[1]!) && !isPlaceholder(m[1]!) ? m[1]! : null
}

function redactAssignments(t: string): string {
  if (t.includes('=')) {
    t = t.replace(ENV_STR_RE, (m, name: string, raw: string) => {
      if (!isSecretName(name)) return m
      let inner = raw
      try {
        inner = JSON.parse(`"${raw}"`) as string
      } catch {
        // not JSON-escaped: read it as it stands
      }
      if (inner.startsWith(MARK)) return m
      const core = valueToHide(inner, { quoted: true, upperName: isUpperName(name), eol: false })
      if (core === null) return m
      note(raw, name)
      note(inner, name)
      return `"${name}=${placeholder(name)}"`
    })
    t = t.replace(EQ_LINE_RE, (m, pre: string, lead: string, name: string, sep: string, raw: string) => {
      if (!isSecretName(name)) return m
      const [inner, q] = unquote(raw)
      const core = /^[a-z][a-z0-9+.-]*:\/\//i.test(inner) ? urlUserinfo(inner)
        : valueToHide(inner, { quoted: q !== '', upperName: isUpperName(name), eol: true })
      return core === null ? m : `${pre}${lead}${name}${sep}${swap(raw, core, name)}`
    })
    t = t.replace(EQ_INLINE_RE, (m, pre: string, name: string, raw: string) => {
      if (!isSecretName(name)) return m
      const [inner, q] = unquote(raw)
      const core = /^[a-z][a-z0-9+.-]*:\/\//i.test(inner) ? urlUserinfo(inner)
        : valueToHide(inner, { quoted: q !== '', upperName: isUpperName(name), eol: false })
      return core === null ? m : `${pre}${name}=${swap(raw, core, name)}`
    })
  }
  if (t.includes('(')) t = t.replace(CALL_DEFAULT_RE, (m, fn: string, open: string, q: string, name: string, comma: string, raw: string) =>
    hideQuoted(m, name, raw, `${fn}${open}${q}${name}${q}${comma}`))
  if (t.includes('=>')) t = t.replace(RUBY_SYM_RE, (m, name: string, sep: string, raw: string) => hideQuoted(m, name, raw, `:${name}${sep}`))
  if (t.includes(':') || t.includes('=>')) {
    t = t.replace(JSON_PAIR_RE, (m, q1: string, name: string, sep: string, raw: string) => {
      if (!isSecretName(name)) return m
      const [inner] = unquote(raw)
      const core = /^[a-z][a-z0-9+.-]*:\/\//i.test(inner) ? urlUserinfo(inner)
        : valueToHide(inner, { quoted: true, upperName: isUpperName(name), eol: false })
      return core === null ? m : `${q1}${name}${q1}${sep}${swap(raw, core, name)}`
    })
    t = t.replace(COLON_RE, (m, pre: string, name: string, sep: string, raw: string) => {
      if (!isSecretName(name)) return m
      const [inner, q] = unquote(raw)
      if (q === '' && /^(bearer|basic|token|bot)\s+\S/i.test(inner)) {
        const tok = inner.replace(/^\S+\s+/, '').split(/\s/)[0]!.replace(/[.,;]$/, '')
        return tok.length >= 6 && !isReference(tok) && !isPlaceholder(tok) ? `${pre}${name}${sep}${swap(raw, tok, name)}` : m
      }
      const core = /^[a-z][a-z0-9+.-]*:\/\//i.test(inner) ? urlUserinfo(inner)
        : valueToHide(inner, { quoted: q !== '', upperName: isUpperName(name), eol: q === '' })
      return core === null ? m : `${pre}${name}${sep}${swap(raw, core, name)}`
    })
  }
  if (t.includes('-')) {
    t = t.replace(FLAG_RE, (m, pre: string, flag: string, sep: string, raw: string) => {
      const name = flag.replace(/^-+/, '')
      if (name.length < 3 || !isSecretName(name)) return m
      const [inner, q] = unquote(raw)
      if (inner.startsWith('-')) return m
      if (q === '' && /^[a-z]{1,11}$/.test(inner)) return m // --show-token prints …, --token file
      const core = valueToHide(inner, { quoted: q !== '', upperName: true, eol: false })
      return core === null ? m : `${pre}${flag}${sep}${swap(raw, core, name)}`
    })
  }
  return redactCliFlags(t)
}

/** Kubernetes Secret manifests: every value under data / stringData. */
function redactK8sSecret(t: string): string {
  if (!/kind["']?\s*:\s*["']?Secret\b/.test(t)) return t
  t = t.replace(/^([ \t]*)(data|stringData):[ \t]*\n((?:\1[ \t]+[^\n]*(?:\n|$))+)/gm, (_m, ind: string, key: string, block: string) =>
    `${ind}${key}:\n` + block.replace(/^([ \t]+)([^\s:#][^:\n]*?)(:[ \t]+)(\S[^\n]*?)[ \t]*$/gm, (line, i2: string, k: string, sep: string, v: string) =>
      v.startsWith(MARK) || /^[|>][-+]?$/.test(v) ? line : (note(v, k), `${i2}${k}${sep}${placeholder(k.replace(/["']/g, '').slice(0, 60))}`)))
  t = t.replace(/("(?:data|stringData)"\s*:\s*\{)([^{}]*)(\})/g, (_m, open: string, body: string, close: string) =>
    open + body.replace(/("([^"\n]+)"\s*:\s*)"([^"\\\n]*)"/g, (x, head: string, k: string, v: string) =>
      v.length === 0 || v.startsWith(MARK) ? x : (note(v, k), `${head}"${placeholder(k.slice(0, 60))}"`)) + close)
  return t
}

/**
 * A ~/.pgpass line, `host:port:db:user:password`, read as libpq reads it: any characters in a field, `\:` and `\\`
 * escaped, the password ended by the line or the first unescaped colon, so a mask never runs past it. A grep prefix
 * (`file:N:` or `N:`) before a real line is allowed. The shape also fits ordinary lines; those are turned away by what
 * they are (pgpassOverreach), not by narrowing what a real line may hold.
 */
const PG_FIELD = String.raw`(?:[^:\\\n]|\\[^\n])+`
const PG_WORD = String.raw`(?:[^:\\\s]|\\[^\s])+`
const PGPASS_RE = new RegExp(
  String.raw`^(((?:(?:[^\s:]{1,300}:)?\d{1,7}[:-])?)((?![#])${PG_WORD}):(\d{1,5}|\*):${PG_FIELD}:${PG_FIELD}:)(?!‹secret:)(${PG_WORD})(?=[ \t\r]*$|:)(?=([^\n]*))`,
  'gm',
)
/** File names `grep -n` prints before a line number; a host never ends so. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|jsonl?|json5|md|mdx|ya?ml|toml|ini|conf|cfg|env|log|txt|csv|tsv|sql|sh|bash|zsh|py|rb|php|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|html?|css|scss|vue|svelte|xml|lock|tpl|twig|gradle|properties)$/i

/** A line in the .pgpass shape that is something else: a grep -n hit, a clock time or MAC address, a JSON line. */
function pgpassOverreach(line: string, prefix: string, host: string, port: string): boolean {
  if (!prefix && SOURCE_FILE.test(host) && /^\d+$/.test(port)) return true // notes.md:3:a:b:c
  if (/(?:^|T)\d{1,2}$/.test(host) && /^\d{2}$/.test(port)) return true // 12:34:56:…, 2026-10-04T18:48:12Z, 00:11:22:…
  return /"[^"\s:]{1,80}"\s*:/.test(line) // a JSON key: `{"agent":"probe:…`
}

/** ~/.netrc and ~/.pgpass lines, docker config "auth". */
function redactCredentialLines(t: string): string {
  if (/(^|\n)[ \t]*(machine|default)[ \t]+\S/.test(t)) {
    // netrc lines only: `machine H login U password P` or an indented `password P` under one.
    t = t.replace(/^([ \t]*(?:(?:machine|default)(?:[ \t]+\S+)?[ \t]+)?(?:login[ \t]+\S+[ \t]+)?password[ \t]+)(\S+)([ \t]*(?:account[ \t]+\S+)?[ \t]*)$/gm, (m, head: string, v: string, tail: string) =>
      v.startsWith(MARK) || isPlaceholder(v) ? m : (note(v, 'netrc-password'), `${head}${placeholder('netrc-password')}${tail}`))
  }
  t = t.replace(PGPASS_RE, (m, head: string, prefix: string, host: string, port: string, v: string, rest: string) =>
    v === '*' || pgpassOverreach(head + v + rest, prefix, host, port) ? m : (note(v, 'pgpass-password'), `${head}${placeholder('pgpass-password')}`))
  t = t.replace(/("auth"\s*:\s*")([A-Za-z0-9+/=]{16,})(")/g, (_m, a: string, v: string, b: string) => (note(v, 'docker-auth'), `${a}${placeholder('docker-auth')}${b}`))
  return t
}

/**
 * Four or more consecutive lines that are each one base64 run of 60-76
 * characters: a PEM body (also one whose header a format mangled, as RTF does)
 * or a wrapped encoding of a file. Hidden whole; certificates and encoded
 * attachments go with them, which costs the model nothing it could read.
 */
const B64_LINE = /^[A-Za-z0-9+/]+={0,2}$/
const b64Core = (line: string) => line.replace(/\\?\r?$/, '').trim()
const isB64Full = (line: string) => {
  const c = b64Core(line)
  return c.length >= 60 && c.length <= 76 && B64_LINE.test(c)
}
const isB64Tail = (line: string) => {
  const c = b64Core(line)
  return c.length >= 2 && c.length <= 76 && B64_LINE.test(c) && (c.endsWith('=') || c.length >= 4)
}

/**
 * Line scan, linear in the output: a regex over repeated lines backtracks
 * quadratically on a long block. A run of 2-3 wrapped lines (a short file's
 * encoding) goes too when, joined, it holds a known value's base64 form.
 */
function redactB64Blocks(t: string, idx: Index): string {
  if (!/[A-Za-z0-9+/]{60}/.test(t)) return t
  const lines = t.split('\n')
  const out: string[] = []
  let changed = false
  let i = 0
  while (i < lines.length) {
    if (!isB64Full(lines[i]!)) {
      out.push(lines[i]!)
      i++
      continue
    }
    let j = i
    while (j < lines.length && isB64Full(lines[j]!)) j++
    if (j < lines.length && isB64Tail(lines[j]!)) j++
    const run = lines.slice(i, j)
    const all = run.join('')
    if ((run.length >= 4 && /\d/.test(all) && /[A-Z]/.test(all) && /[a-z]/.test(all)) || (run.length >= 2 && idx.known && all.replace(/\s+/g, '').search(idx.known) >= 0)) {
      out.push(placeholder('base64-block'))
      changed = true
    } else {
      out.push(...run)
    }
    i = j
  }
  return changed ? out.join('\n') : t
}

/**
 * Hides every secret value in `input`. Pure; returns `input` itself when nothing
 * matched. A value a rule found by its name or flag is hidden wherever else it
 * appears in the same text (a token in `'token' => '…'` and again as a bare
 * argument); `found`, when given, receives those values.
 */
export function redactText(input: string, idx: Index, found?: Map<string, string>): string {
  if (input.length < 6) return input
  const outer = collector
  const mine = new Map<string, string>()
  collector = mine
  let t: string
  try {
    t = redactPass(input, idx)
  } finally {
    collector = outer
  }
  if (mine.size > 0) {
    const alts = [...mine.keys()].sort((a, b) => b.length - a.length).map(v => valueAlt(v))
    // placeholders are matched first and kept, so a value is never replaced inside one
    const re = new RegExp(`‹secret:[^›\\s]*›|${alts.join('|')}`, 'g')
    t = t.replace(re, m => (m.startsWith(MARK) ? m : placeholder(mine.get(m) ?? 'secret')))
    if (found) for (const [v, n] of mine) found.set(v, n)
  }
  return t === input ? input : t
}

function redactPass(input: string, idx: Index): string {
  let t = input
  if (t.includes('PRIVATE KEY')) t = t.replace(PEM_RE, () => placeholder('private-key'))
  // wrapped runs first: a known value's encoding split across a line break is whole only before inline replacement
  if (t.includes('\n') && (t.length >= 240 || idx.known)) t = redactB64Blocks(t, idx)
  if (idx.known) t = t.replace(idx.known, m => placeholder(idx.byValue.get(m) ?? 'secret'))
  t = applyShapes(t)
  t = redactUrls(t)
  t = redactK8sSecret(t)
  t = redactHeaders(t)
  t = redactXml(t)
  t = redactAssignments(t)
  t = redactCredentialLines(t)
  return t
}

// ---------------------------------------------------------------------------
// Deep walk over a tool result
// ---------------------------------------------------------------------------

const BINARY_TYPES = new Set(['image', 'document', 'audio', 'blob', 'pdf'])

/** Redacts every string in a JSON-like value, sharing untouched parts; binary payloads are left alone. */
export function redactDeep(value: unknown, idx: Index, found?: Map<string, string>): { value: unknown; changed: boolean } {
  let changed = false
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      const r = redactText(v, idx, found)
      if (r !== v) changed = true
      return r
    }
    if (v === null || typeof v !== 'object') return v
    if (depth > 40) {
      // too deep to walk: redact its JSON whole; a result that no longer parses throws, and the caller hides the output
      const json = JSON.stringify(v)
      const r = redactText(json, idx, found)
      if (r === json) return v
      changed = true
      return JSON.parse(r) as unknown
    }
    if (Array.isArray(v)) {
      let out: unknown[] | null = null
      v.forEach((item, i) => {
        const r = walk(item, depth + 1)
        if (r !== item) (out ??= v.slice())[i] = r
      })
      return out ?? v
    }
    const obj = v as Record<string, unknown>
    const isBinary = (typeof obj.type === 'string' && BINARY_TYPES.has(obj.type)) || typeof obj.mimeType === 'string' && /^(image|audio|video)\//.test(obj.mimeType) || obj.isImage === true
    let out: Record<string, unknown> | null = null
    for (const [k, item] of Object.entries(obj)) {
      if (k === 'base64' || (isBinary && (k === 'data' || k === 'blob' || k === 'stdout' || k === 'source'))) continue
      const r = walk(item, depth + 1)
      if (r !== item) (out ??= { ...obj })[k] = r
    }
    return out ?? v
  }
  const result = walk(value, 0)
  return { value: result, changed }
}

// ---------------------------------------------------------------------------
// Credential files read whole with the Read tool
// ---------------------------------------------------------------------------

/** The kind of credential file at `path` (whose content is hidden whole), or undefined. */
export function credentialFileKind(path: string): string | undefined {
  const p = path.replace(/\\/g, '/')
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (/\/\.ssh\//.test(p) && !base.endsWith('.pub') && !/^(config|known_hosts(\.old)?|authorized_keys2?|environment|rc)$/.test(base)) return 'ssh private key'
  if (/\/\.aws\/credentials$/.test(p)) return 'aws credentials'
  if (/\/(gh|glab-cli)\/(hosts|config)\.ya?ml$/.test(p)) return 'gh/glab token store'
  if (/\/\.claude\/\.credentials\.json$/.test(p)) return 'Claude credentials'
  if (/\/\.(zsh|bash|sh|python|psql|mysql|node_repl|sqlite|irb|rediscli)_history$|\/\.history$|\/\.zhistory$/.test(p)) return 'shell history'
  if (/\/\.git-credentials$|\/\.netrc$|\/_netrc$|\/\.pgpass$/.test(p)) return 'stored passwords'
  if (/\.(kdbx|p12|pfx|jks|keystore)$/i.test(base)) return 'key store'
  return undefined
}

/**
 * The credential file an attachment re-renders (`file` after a compaction, `edited_text_file` when it changed on disk):
 * the first path in its text is the file's own. Undefined for any other file.
 */
export function credentialPathIn(text: string): { path: string; kind: string } | undefined {
  const path = /(?:~|\/)[^\s"'`<>()]*[^\s"'`<>().,:;]/.exec(text)?.[0]
  const kind = path === undefined ? undefined : credentialFileKind(path)
  return kind === undefined ? undefined : { path: path!, kind }
}

export function credentialNotice(path: string, kind: string): string {
  return `secrets-redact: ${path} is a credential file (${kind}); its content is hidden from you. ` +
    'Use it by path where a tool takes one (ssh -i, git, gh, aws), check it with ls/stat, or ask the owner.'
}

// ---------------------------------------------------------------------------
// Placeholders never travel back into a file or a command
// ---------------------------------------------------------------------------

export const PLACEHOLDER_DENY =
  'secrets-redact: this input contains a ‹secret:NAME#…› placeholder from a tool output. The value is hidden from you, ' +
  'and writing the placeholder would replace the real value with it. Use the variable by shell substitution instead ' +
  '(psql "$DATABASE_URL"; set -a; . ./.env; set +a; cmd), or ask the owner to make this change.'

/** A placeholder this mod produced (its nonce), not text about placeholders (`‹secret:NAME›` in a test or a doc). */
export function hasPlaceholder(s: unknown): boolean {
  if (typeof s !== 'string' || !s.includes(`#${nonce}›`)) return false
  return new RegExp(`‹secret:[^›\\s]{1,120}#${nonce}›`).test(s)
}

/** Does any string anywhere in a tool's input carry a produced placeholder? */
export function inputHasPlaceholder(input: Record<string, unknown>): boolean {
  const seen = (v: unknown, depth: number): boolean => {
    if (typeof v === 'string') return hasPlaceholder(v)
    if (v === null || typeof v !== 'object') return false
    if (depth > 40) return hasPlaceholder(JSON.stringify(v))
    return (Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)).some(x => seen(x, depth + 1))
  }
  return Object.entries(input).some(([k, v]) => k !== 'tool' && k !== 'tool_use_id' && k !== 'agentId' && seen(v, 0))
}

// ---------------------------------------------------------------------------
// Sources of known values
// ---------------------------------------------------------------------------

export type Pair = readonly [name: string, value: string]

/** Known secrets from NAME=value pairs: whole values, URL passwords, random URL segments, app-password variants. */
export function secretsFromPairs(pairs: readonly Pair[]): Secret[] {
  const out: Secret[] = []
  for (const [name, rawValue] of pairs) {
    const value = rawValue.trim()
    const secretName = isSecretName(name)
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      const m = /^[a-z][a-z0-9+.-]*:\/\/([^\s/?#@]*)@/i.exec(value)
      const userinfo = m?.[1] ?? ''
      const colon = userinfo.indexOf(':')
      const pass = colon >= 0 ? safeDecode(userinfo.slice(colon + 1)) : ''
      if (pass && isKnownCandidate(pass, true)) out.push({ name, value: pass })
      if (pass && pass !== userinfo.slice(colon + 1) && isKnownCandidate(userinfo.slice(colon + 1), true)) out.push({ name, value: userinfo.slice(colon + 1) })
      if (colon < 0 && secretName && userinfo.length >= 8 && isKnownCandidate(userinfo, true)) out.push({ name, value: userinfo })
      for (const seg of value.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').split(/[/?&=#]+/)) {
        if (isKnownCandidate(seg, false)) out.push({ name, value: seg })
      }
      continue
    }
    if (secretName && /^(bearer|basic|token|bot)\s+\S{8,}$/i.test(value)) {
      const tok = value.replace(/^\S+\s+/, '')
      if (isKnownCandidate(tok, true)) out.push({ name, value: tok })
      continue
    }
    if (value.includes('\n')) {
      for (const line of value.split('\n')) if (secretName ? isSecretValue(line) : isKnownCandidate(line, false)) out.push({ name, value: line.trim() })
      continue
    }
    if (secretName ? isSecretValue(value) : isKnownCandidate(value, false)) {
      out.push({ name, value })
      if (/^[a-z]{4}( [a-z]{4}){3}$/.test(value)) out.push({ name, value: value.replace(/ /g, '') })
    }
  }
  return out
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** NAME=value pairs of a dotenv file (export prefix, quotes, multi-line double quotes, inline comments). */
export function parseDotenv(text: string): Pair[] {
  const out: Pair[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(lines[i]!)
    if (!m) continue
    const name = m[1]!
    let v = m[2]!
    const q = v[0]
    if (q === '"' || q === "'" || q === '`') {
      let body = v.slice(1)
      let end = findClose(body, q)
      while (end < 0 && i + 1 < lines.length) {
        body += '\n' + lines[++i]!
        end = findClose(body, q)
      }
      v = end < 0 ? body : body.slice(0, end)
      if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1')
    } else {
      v = v.replace(/\s+#.*$/, '').trim()
    }
    out.push([name, v])
  }
  return out
}

function findClose(s: string, q: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && q === '"') i++
    else if (s[i] === q) return i
  }
  return -1
}

/** export NAME=value lines of a shell rc file; computed values ($VAR, $(cmd)) are skipped — the env dump has them. */
export function parseShellRc(text: string): Pair[] {
  const out: Pair[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export|typeset\s+-x|declare\s+-x|setenv)?\s*([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;#]*)/.exec(line)
    if (!m) continue
    const [inner, q] = unquote(m[2]!)
    if (q !== "'" && /\$|`/.test(inner)) continue
    out.push([m[1]!, inner])
  }
  return out
}

/** NAME=value pairs of `env -0` output. */
export function parseEnvDump(text: string): Pair[] {
  const out: Pair[] = []
  for (const entry of text.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq > 0) out.push([entry.slice(0, eq), entry.slice(eq + 1)])
  }
  return out
}

/** env / headers / --flag values of every MCP server in a ~/.claude.json or .mcp.json. */
export function parseMcpJson(text: string): Pair[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const out: Pair[] = []
  const servers: unknown[] = []
  const collect = (holder: unknown) => {
    const m = (holder as { mcpServers?: unknown } | null)?.mcpServers
    if (m && typeof m === 'object') servers.push(...Object.values(m as Record<string, unknown>))
  }
  collect(data)
  const projects = (data as { projects?: unknown } | null)?.projects
  if (projects && typeof projects === 'object') for (const p of Object.values(projects as Record<string, unknown>)) collect(p)
  for (const s of servers) {
    if (!s || typeof s !== 'object') continue
    const srv = s as { env?: unknown; headers?: unknown; args?: unknown; url?: unknown }
    for (const bag of [srv.env, srv.headers]) {
      if (bag && typeof bag === 'object') for (const [k, v] of Object.entries(bag as Record<string, unknown>)) if (typeof v === 'string') out.push([k, v])
    }
    if (Array.isArray(srv.args)) {
      const args = srv.args.filter((a): a is string => typeof a === 'string')
      args.forEach((a, i) => {
        const eq = /^--?([A-Za-z][\w-]*)=(.+)$/.exec(a)
        if (eq) out.push([eq[1]!, eq[2]!])
        else if (/^--?[A-Za-z][\w-]*$/.test(a) && args[i + 1] !== undefined && !args[i + 1]!.startsWith('-')) out.push([a.replace(/^-+/, ''), args[i + 1]!])
        else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) out.push(['mcp-arg', a])
      })
    }
    if (typeof srv.url === 'string') out.push(['mcp-url', srv.url])
  }
  return out
}

/** The env block of a Claude Code settings file. */
export function parseSettingsEnv(text: string): Pair[] {
  try {
    const env = (JSON.parse(text) as { env?: unknown } | null)?.env
    if (!env || typeof env !== 'object') return []
    return Object.entries(env as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string')
  } catch {
    return []
  }
}

/** Words that say the next backticked token is a credential. */
const MD_CRED_WORD = /(парол\p{L}*|password|passwd|\bpass\b|\bpwd\b|token|токен\p{L}*|secret|секрет\p{L}*|ключ\p{L}*|\bkey\b|api[ _-]?key|\bhash\b|хеш|creds?|credentials?|basic auth)/giu
/** Words that say it is an identity or a place instead (a login, a host, a path). */
const MD_ID_WORD = /(логин\p{L}*|login|\buser\p{L}*|юзер\p{L}*|пользовател\p{L}*|почт\p{L}*|e-?mail|\bhost\p{L}*|хост\p{L}*|\bport\b|порт\p{L}*|\burl\b|адрес\p{L}*|\bdb\b|база|database|имя|\bname\b|path|путь|файл\p{L}*|\bfile\b|команд\p{L}*|command|ssh|туннел\p{L}*|tunnel|опци\p{L}*|option|канал\p{L}*|github|gitlab|домен\p{L}*|domain)/giu

/** A backticked token that is a path, a file, a command, a login or a label, not a secret. */
function mdNotSecret(tok: string): boolean {
  if (/\s/.test(tok) && !/^[a-z]{4}( [a-z]{4}){3}$/.test(tok)) return true
  if (tok.includes('/') && !/^[A-Za-z0-9+/]{20,}={0,2}$/.test(tok)) return true
  if (/\.[a-z]{1,5}$/i.test(tok) && !/\d.*\.[a-z]{1,5}$/i.test(tok.slice(-6))) return true // file.md, host.com
  if (tok.includes('@') || tok.startsWith('-') || /[*?]/.test(tok)) return true // logins, flags, globs
  if (/=/.test(tok) && !/^[A-Za-z0-9+/_-]+={1,2}$/.test(tok)) return true // Option=value
  if (/^[a-z][a-z0-9]*([_-][a-z0-9]+)+$/.test(tok)) return true // order_source, accept-new, id_ed25519_dima
  if (/^([a-z][a-z0-9]*(_[a-z0-9]+)*|[a-z]+([A-Z][a-z0-9]*)+|[A-Z][A-Z0-9]*(_[A-Z0-9]+)*)$/.test(tok) && isSecretName(tok)) return true
  return false
}

/** A person's identity word: the token after it and a bare separator is that person's password. */
const MD_LOGIN_WORD = /(логин\p{L}*|login|\buser\p{L}*|юзер\p{L}*|пользовател\p{L}*)/iu

/**
 * Values of a Markdown access note, as an env generator script reads them.
 *
 * A line holding a backticked secret NAME (`SHOP_PROD_PASSWORD_ACME`)
 * gives that name the last backticked token after it. Any other backticked
 * token is skipped when an identity word (логин, host, path, github …) stands
 * closest before it or it reads as a path, file, command, login or label;
 * otherwise it counts when the words before it name a credential (пароль,
 * token, key …), when only a separator parts it from such a context or from a
 * login (`user` / `pass`), or when it looks random on its own (a generated
 * password in a table row). A plain `password: value` line is read too.
 */
export function parseMarkdownSecrets(text: string, label: string): Secret[] {
  const out: Secret[] = []
  const lastAt = (re: RegExp, str: string) => {
    let at = -1
    for (const m of str.matchAll(re)) at = m.index! + m[0].length
    return at
  }
  for (const line of text.split(/\r?\n/)) {
    const toks = [...line.matchAll(/`([^`\n]+)`/g)]
    const named = toks.findIndex(m => /^[A-Z][A-Z0-9_]{2,}$/.test(m[1]!.trim()) && isSecretName(m[1]!.trim()))
    if (named >= 0) {
      const name = toks[named]![1]!.trim()
      const value = toks.slice(named + 1).map(m => m[1]!.trim()).reverse().find(t => !/^[A-Z][A-Z0-9_]{2,}$/.test(t))
      if (value !== undefined && !mdNotSecret(value)) out.push(...secretsFromPairs([[name, value]]))
      continue
    }
    let from = 0
    let prevLogin = false
    for (const m of toks) {
      const tok = m[1]!.trim()
      const lead = line.slice(from, m.index!).slice(-60)
      from = m.index! + m[0].length
      const login = MD_LOGIN_WORD.test(lead)
      const afterLogin = prevLogin
      prevLogin = login
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tok)) {
        out.push(...secretsFromPairs([[label, tok]])) // only a URL's password is taken
        continue
      }
      const cred = lastAt(MD_CRED_WORD, lead)
      const id = lastAt(MD_ID_WORD, lead)
      if (id > cred || mdNotSecret(tok)) continue
      const bare = /^[\s/:,;|—–-]*$/.test(lead)
      const context = cred >= 0 || (bare && (afterLogin || lastAt(MD_CRED_WORD, line.slice(0, m.index!)) >= 0))
      if (isKnownCandidate(tok, context)) out.push({ name: label, value: tok })
    }
    if (toks.length === 0) {
      const m = /(?:password|пароль|token|токен|secret|секрет|key|ключ)\s*[:=—–-]\s*(\S{8,})/i.exec(line)
      const v = m?.[1]!.replace(/[.,;]$/, '')
      if (v !== undefined && !mdNotSecret(v) && isKnownCandidate(v, true)) out.push({ name: label, value: v })
    }
  }
  return out
}
