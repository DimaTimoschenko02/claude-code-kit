// Fake values only. Token-shaped ones are built by concatenation so this file
// never holds a literal that a secret scanner (or the mod itself) would flag.

const rep = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n)

export const FAKE = {
  ghToken: 'gh' + 'p_' + rep('Fak3T0ken', 36),
  ghPat: 'github' + '_pat_' + rep('11FAKE0', 82),
  anthropic: 'sk-' + 'ant-api03-' + rep('FakeKey0', 40),
  oauthAccess: 'sk-' + 'ant-oat01-' + rep('FakeOat1', 40),
  oauthRefresh: 'sk-' + 'ant-ort01-' + rep('FakeOrt2', 40),
  openai: 'sk-' + 'proj-' + rep('Fak3Open1', 40),
  google: 'AI' + 'za' + rep('FakeGoog1e_', 35),
  slack: 'xo' + 'xb-' + '1234567890-' + rep('FakeSlack', 24),
  aws: 'AK' + 'IA' + 'FAKE0000FAKE0000',
  awsSecret: rep('FakeAwsSecret/Key+0', 40),
  stripe: 'sk' + '_live_' + rep('Fak3Str1pe', 24),
  telegram: '1234567890:' + rep('AAFakeTeleg', 35),
  notion: 'nt' + 'n_' + rep('Fak3N0tion', 46),
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.ey' + 'JzdWIiOiJmYWtlIiwiZXhwIjoxfQ.' + rep('FakeSig0', 43),
  glpat: 'gl' + 'pat-' + rep('Fak3Lab', 20),
  dbPassword: 'Fk3-db-PASS-9x7q',
  urlPassword: 'Fk-url-P4ss',
  redisPassword: 'Fk-redis-77aa',
  gmailApp: 'qwer tyui asdf ghjk',
  sessionSecret: 'S3ss!on-Fake-Secret',
  webhookSeg: '7f3a9c2e1b4d8f6a0c5e',
  zshKey: rep('FakeZsh9', 32),
  apiToken: 'Fk-tok-123456',
  dockerPw: 'Dock3r-Fake-Pw',
  k8sB64: 'RmFrZVBhc3N3b3JkMTIz',
  jsonApiKey: 'Fk-json-0a1b2c3d4e5f',
  exportKey: 'xk-Fake-1234-ABCD-5678',
  envOnly: 'Zx9-fake-Pw-env',
  mysqlPw: 'Fk-My5ql-Pass',
  pgpassPw: 'Fk-pgpass-42xy',
  awsSmPw: 'Fk-aws-Pw-123',
  basicB64: rep('ZmFrZTpmYWtl', 24),
  dockerAuth: 'ZmFrZXVzZXI6ZmFrZXBhc3N3b3Jk',
  tgApiHash: '0123456789abcdef0123456789abcdef',
  accessMd: 'Acc3ss-Md-Fake-77',
  mdTable: 'Xk29aLm3Qp8Rt5Vw1Yz0',
  mdBasic: 'qa7x9k2m',
  mdLogin: 'Pw4dima77',
  mdNamed: 'Kn1g-Prod-Fake-88',
  mdPlain: 'Pl41n-Fake-Pass',
  // review 2026-10-04 (F2): shapes the rules missed with an empty index
  shape: 'Fk3-gr3p-PASS-77',
  shapeOld: 'old1-Fake-x9z',
  phpToken: 'Fk3PhpTok3nValue0123',
  quoted: 'Ab"c\\d-Fake-99',
  npmrc: 'Fk3-npm-rc-Tok-9x7q-Long',
  pem:
    '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\n' +
    'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n' +
    'QyNTUxOQAAACBGQUtFRkFLRUZBS0VGQUtFRkFLRUZBS0VGQUtFRkFLRQAAAJgFAKEFAKE\n' +
    '-----END OPENSSH ' + 'PRIVATE KEY-----',
} as const

/** Every fake that must never survive redaction once its source or shape is known. */
export const ALL_FAKE_SECRETS: readonly string[] = Object.entries(FAKE)
  .filter(([k]) => k !== 'pem')
  .map(([, v]) => v)

// ---------------------------------------------------------------------------
// Fixture files the mod loads as sources of known values
// ---------------------------------------------------------------------------

export const ENV_FILE = [
  '# local env (fake fixture)',
  'NODE_ENV=development',
  'PORT=3000',
  'LOG_LEVEL=debug',
  'FILES_DIR=./var/files',
  `DATABASE_URL=postgres://acme:${FAKE.urlPassword}@127.0.0.1:5435/acme`,
  `DB_PASSWORD=${FAKE.dbPassword}`,
  `GMAIL_APP_PASSWORD="${FAKE.gmailApp}"`,
  `TELEGRAM_BOT_TOKEN=${FAKE.telegram}`,
  `OPENAI_API_KEY=${FAKE.openai}`,
  `SESSION_SECRET='${FAKE.sessionSecret}'`,
  `N8N_HOOK=https://n8n.example.org/webhook/${FAKE.webhookSeg}`,
  '',
].join('\n')

export const ENV_EXAMPLE = [
  '# Registry of variables; copy to .env and fill in',
  'NODE_ENV=development',
  'DATABASE_URL=postgres://user:password@localhost:5432/acme',
  'DB_PASSWORD=',
  'GMAIL_APP_PASSWORD=your-gmail-app-password',
  'TELEGRAM_BOT_TOKEN=<bot-token>',
  'OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxx',
  'SESSION_SECRET=changeme',
  'STRIPE_SECRET_KEY=',
  'API_KEY=${API_KEY}',
  '',
].join('\n')

export const ZSHENV = `export PATH="$HOME/bin:$PATH"\nexport GEMINI_API_KEY=${FAKE.zshKey}\nexport EDITOR=vim\n`

export const ACCESS_MD = [
  '---',
  'name: access',
  '---',
  '# Accesses',
  '- Admin panel: https://admin.example.org',
  `- \`ADMIN_PASSWORD\` — \`${FAKE.accessMd}\``,
  '- Server: `ssh app@203.0.113.7`',
  '',
  '| user | host | password |',
  '|---|---|---|',
  `| \`app\` | \`203.0.113.7\` | \`${FAKE.mdTable}\` |`,
  `- Basic auth для хоста \`stand\`: \`admin\` / \`${FAKE.mdBasic}\``,
  `- Админка: логин \`app\`, \`${FAKE.mdLogin}\``,
  `- Прод, только чтение: \`SHOP_PROD_PASSWORD_ACME\` (юзер \`acme_ro\`) — \`${FAKE.mdNamed}\``,
  '- GitHub юзер `AliceFake2024Handle`, ключ `id_ed25519_alice_fake`',
  '- Туннель прячет (`app_setting`, `app_user*`); скрипт `bin/acme-env` пишет пароли в env',
  '- ssh с опцией `ServerAliveInterval=30`, ключ для туннеля `shop-tunnel-key`',
  `password: ${FAKE.mdPlain}`,
  '',
].join('\n')

/** `env -0` of the Claude process. */
export const PROC_ENV = ['HOME=/home/fake', 'PATH=/usr/bin:/bin', `MY_SERVICE_PASSWORD=${FAKE.envOnly}`, 'TERM=xterm-256color', ''].join('\0')

// ---------------------------------------------------------------------------
// Tool outputs: leaks that must be hidden
// ---------------------------------------------------------------------------

export type LeakCase = { readonly name: string; readonly text: string; readonly hide: readonly string[]; readonly keep?: readonly string[] }

export const LEAKS: readonly LeakCase[] = [
  {
    name: 'cat .env (battery: cat .env, git show HEAD:.env, cat prod.env)',
    text: ENV_FILE,
    hide: [FAKE.urlPassword, FAKE.dbPassword, FAKE.gmailApp, FAKE.telegram, FAKE.openai, FAKE.sessionSecret, FAKE.webhookSeg],
    keep: ['NODE_ENV=development', 'PORT=3000', 'FILES_DIR=./var/files', 'DATABASE_URL=postgres://acme:', '@127.0.0.1:5435/acme', 'GMAIL_APP_PASSWORD=', 'N8N_HOOK=https://n8n.example.org/webhook/'],
  },
  {
    name: 'printenv with fake secrets (battery: env, set, printenv)',
    text: ['HOME=/home/fake', `GITHUB_TOKEN=${FAKE.ghToken}`, `MY_SERVICE_PASSWORD=${FAKE.envOnly}`, `AWS_ACCESS_KEY_ID=${FAKE.aws}`, `AWS_SECRET_ACCESS_KEY=${FAKE.awsSecret}`, 'PATH=/usr/bin:/bin', 'LANG=en_US.UTF-8', `SOME_LABEL=${FAKE.gmailApp}`].join('\n'),
    hide: [FAKE.ghToken, FAKE.envOnly, FAKE.aws, FAKE.awsSecret, FAKE.gmailApp],
    keep: ['HOME=/home/fake', 'PATH=/usr/bin:/bin', 'LANG=en_US.UTF-8', 'GITHUB_TOKEN=', 'AWS_SECRET_ACCESS_KEY='],
  },
  {
    name: 'docker inspect Env array (battery: docker inspect .Config.Env)',
    text: JSON.stringify([{ Id: 'f00ba4', Config: { Image: 'postgres:16', Env: [`POSTGRES_PASSWORD=${FAKE.dockerPw}`, 'POSTGRES_USER=acme', 'PATH=/usr/local/sbin:/usr/local/bin', `DATABASE_URL=postgres://acme:${FAKE.urlPassword}@db:5432/acme`], Cmd: ['postgres'] } }], null, 2),
    hide: [FAKE.dockerPw, FAKE.urlPassword],
    keep: ['"POSTGRES_USER=acme"', '"Image": "postgres:16"', 'POSTGRES_PASSWORD='],
  },
  {
    name: 'docker exec env dump (battery: docker exec … env)',
    text: `PATH=/usr/local/bin\nHOSTNAME=abc123\nMARIADB_ROOT_PASSWORD=${FAKE.mysqlPw}\nMARIADB_DATABASE=shop\n`,
    hide: [FAKE.mysqlPw],
    keep: ['MARIADB_DATABASE=shop', 'HOSTNAME=abc123'],
  },
  {
    name: 'k8s Secret YAML (battery: kubectl get secret -o yaml)',
    text: ['apiVersion: v1', 'kind: Secret', 'metadata:', '  name: acme-db', '  namespace: default', 'type: Opaque', 'data:', `  password: ${FAKE.k8sB64}`, '  username: cHJpY2VodWI=', 'stringData:', `  DATABASE_URL: postgres://acme:${FAKE.urlPassword}@db:5432/acme`, ''].join('\n'),
    hide: [FAKE.k8sB64, 'cHJpY2VodWI=', FAKE.urlPassword],
    keep: ['name: acme-db', 'kind: Secret', 'namespace: default', 'password: ', 'username: '],
  },
  {
    name: 'k8s Secret JSON (kubectl get secret -o json)',
    text: JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'acme-db' }, data: { password: FAKE.k8sB64, 'tls.key': 'LS0tLS1CRUdJTiBGQUtF' } }, null, 2),
    hide: [FAKE.k8sB64, 'LS0tLS1CRUdJTiBGQUtF'],
    keep: ['"name": "acme-db"', '"tls.key": '],
  },
  {
    name: 'JSON config "apiKey"',
    text: JSON.stringify({ service: 'search', apiKey: FAKE.jsonApiKey, timeout: 30, endpoint: 'https://api.example.com/v1' }, null, 2),
    hide: [FAKE.jsonApiKey],
    keep: ['"service": "search"', '"timeout": 30', '"endpoint": "https://api.example.com/v1"', '"apiKey": "'],
  },
  {
    name: 'URL with a password in a log line',
    text: `[boot] connecting to redis://default:${FAKE.redisPassword}@redis:6379/0 ... ok\n[boot] db postgres://acme@127.0.0.1:5435/acme (trust auth)`,
    hide: [FAKE.redisPassword],
    keep: ['redis://default:', '@redis:6379/0 ... ok', 'postgres://acme@127.0.0.1:5435/acme (trust auth)'],
  },
  {
    name: 'export X_API_KEY=… (cat ~/.zshrc)',
    text: `# shell\nexport X_API_KEY=${FAKE.exportKey}\nexport PATH="$HOME/.local/bin:$PATH"\nalias ll='ls -la'\n`,
    hide: [FAKE.exportKey],
    keep: ['export X_API_KEY=', 'export PATH="$HOME/.local/bin:$PATH"', "alias ll='ls -la'"],
  },
  {
    name: 'a JWT in a log line',
    text: `2026-10-04T10:00:00Z auth ok session=${FAKE.jwt} user=42`,
    hide: [FAKE.jwt],
    keep: ['2026-10-04T10:00:00Z auth ok', 'user=42'],
  },
  {
    name: 'a PEM private key block (battery: cat ~/.ssh/id_ed25519)',
    text: `key follows\n${FAKE.pem}\nend`,
    hide: [FAKE.pem.split('\n')[1]!, FAKE.pem.split('\n')[2]!],
    keep: ['key follows', 'end'],
  },
  {
    name: 'curl -v with an Authorization header',
    text: `> GET /v1/models HTTP/1.1\n> Host: api.anthropic.com\n> Authorization: Bearer ${FAKE.anthropic}\n> x-api-key: ${FAKE.jsonApiKey}\n< HTTP/1.1 200 OK`,
    hide: [FAKE.anthropic, FAKE.jsonApiKey],
    keep: ['> Host: api.anthropic.com', '> Authorization: Bearer ', '< HTTP/1.1 200 OK'],
  },
  {
    name: 'Claude credentials JSON via Bash (battery: cat ~/.claude/.credentials.json)',
    text: JSON.stringify({ claudeAiOauth: { accessToken: FAKE.oauthAccess, refreshToken: FAKE.oauthRefresh, expiresAt: 1759999999999, scopes: ['user:inference'] } }),
    hide: [FAKE.oauthAccess, FAKE.oauthRefresh],
    keep: ['"expiresAt":1759999999999', '"scopes":["user:inference"]'],
  },
  {
    name: 'gh auth token (battery: gh auth token)',
    text: `${FAKE.ghToken}\n`,
    hide: [FAKE.ghToken],
  },
  {
    name: 'glab auth status --show-token',
    text: `gitlab.com\n  ✓ Logged in to gitlab.com as app\n  ✓ Token: ${FAKE.glpat}\n`,
    hide: [FAKE.glpat],
    keep: ['Logged in to gitlab.com as app', 'Token: '],
  },
  {
    name: '/proc/<pid>/environ, NUL-separated (battery: cat /proc/1234/environ)',
    text: `PATH=/bin\0DB_PASSWORD=${FAKE.dbPassword}\0API_TOKEN=${FAKE.apiToken}\0HOME=/root\0`,
    hide: [FAKE.dbPassword, FAKE.apiToken],
    keep: ['PATH=/bin', 'HOME=/root'],
  },
  {
    name: 'git config --list with credentials (battery: git config dump)',
    text: `user.name=Alice\nurl.https://app:${FAKE.ghToken}@github.com/.insteadof=https://github.com/\nhttp.extraheader=AUTHORIZATION: basic ${FAKE.basicB64}\ncore.editor=vim`,
    hide: [FAKE.ghToken, FAKE.basicB64],
    keep: ['user.name=Alice', 'core.editor=vim', '@github.com/.insteadof=https://github.com/'],
  },
  {
    name: 'ps auxe: env on a command line (battery: ps auxe)',
    text: `app  123  0.0  node dist/main.js DB_PASSWORD=${FAKE.dbPassword} API_TOKEN=${FAKE.apiToken} HOME=/home/fake\nroot 1 0.0 mysqld\ndima 456 0.1 mysql -uroot -p${FAKE.mysqlPw} -h 127.0.0.1 shop`,
    hide: [FAKE.dbPassword, FAKE.apiToken, FAKE.mysqlPw],
    keep: ['node dist/main.js', 'HOME=/home/fake', 'root 1 0.0 mysqld', '-h 127.0.0.1 shop'],
  },
  {
    name: '.netrc and .pgpass lines via Bash',
    text: `machine api.github.com login app password ${FAKE.ghToken}\nlocalhost:5432:acme:acme:${FAKE.pgpassPw}\n`,
    hide: [FAKE.ghToken, FAKE.pgpassPw],
    keep: ['machine api.github.com login app password ', 'localhost:5432:acme:acme:'],
  },
  {
    name: 'docker config.json auths',
    text: JSON.stringify({ auths: { 'ghcr.io': { auth: FAKE.dockerAuth } }, credsStore: 'desktop' }, null, 2),
    hide: [FAKE.dockerAuth],
    keep: ['"ghcr.io"', '"credsStore": "desktop"'],
  },
  {
    name: 'claude mcp list with secrets in args (battery: claude mcp list)',
    text: `telegram: node /srv/tg/server.js --api-hash ${FAKE.tgApiHash} --bot-token ${FAKE.telegram} - ✓ Connected\nnotion: https://mcp.notion.com/mcp (HTTP) - ✓ Connected`,
    hide: [FAKE.tgApiHash, FAKE.telegram],
    keep: ['telegram: node /srv/tg/server.js --api-hash ', 'notion: https://mcp.notion.com/mcp (HTTP) - ✓ Connected'],
  },
  {
    name: 'aws secretsmanager get-secret-value (battery)',
    text: JSON.stringify({ ARN: 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:prod/db', Name: 'prod/db', SecretString: JSON.stringify({ password: FAKE.awsSmPw, username: 'app' }) }, null, 2),
    hide: [FAKE.awsSmPw],
    keep: ['"Name": "prod/db"'],
  },
  {
    name: 'interpreter one-liner printing a known variable (battery: node -e console.log(process.env.GMAIL_APP_PASSWORD))',
    text: `${FAKE.gmailApp}\n`,
    hide: [FAKE.gmailApp],
  },
  {
    name: 'echo of known values from .env, zshenv, process env and access.md',
    text: `${FAKE.dbPassword}\n${FAKE.zshKey}\n${FAKE.envOnly}\n${FAKE.accessMd}\n${FAKE.gmailApp.replace(/ /g, '')}\nhttps://n8n.example.org/webhook/${FAKE.webhookSeg}\n${FAKE.mdTable} ${FAKE.mdBasic} ${FAKE.mdLogin} ${FAKE.mdNamed} ${FAKE.mdPlain}\n`,
    hide: [FAKE.dbPassword, FAKE.zshKey, FAKE.envOnly, FAKE.accessMd, FAKE.gmailApp.replace(/ /g, ''), FAKE.webhookSeg, FAKE.mdTable, FAKE.mdBasic, FAKE.mdLogin, FAKE.mdNamed, FAKE.mdPlain],
    keep: ['https://n8n.example.org/webhook/'],
  },
  {
    name: 'wrapped base64 of an unknown secret file (ssh host base64 /opt/app/.env) and a PEM body under a mangled header',
    text: `${(function () {
      let b = ''
      for (let i = 0; i < 5; i++) b += rep('QUJDRGVmZ2gxMjM0NTY3OA', 76) + '\n'
      return b + 'QUJDRA=='
    })()}\n{\\rtf1 -----BEGIN RSA PRIV\\\nATE KEY-----\\\n${rep('MIIEowIBAAKCAQEAz9Fake0Key1Material', 64)}\\\n${rep('Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA', 64)}\\\n${rep('U2VjcmV0S2V5TWF0ZXJpYWw0NTY', 64)}\\\nAbCd1234==\\\n}`,
    hide: [rep('QUJDRGVmZ2gxMjM0NTY3OA', 76), rep('MIIEowIBAAKCAQEAz9Fake0Key1Material', 64), rep('U2VjcmV0S2V5TWF0ZXJpYWw0NTY', 64)],
    keep: ['{\\rtf1'],
  },
  {
    name: 'INI / TOML with spaces around = (cat ~/.aws/credentials, my.cnf, .pypirc; found by the block-secrets battery regression)',
    text: `[default]\naws_access_key_id = ${FAKE.aws}\naws_secret_access_key = ${FAKE.awsSecret}\nregion = eu-central-1\n\n[client]\nuser = root\npassword = ${FAKE.mysqlPw}\n\n[pypi]\npassword = "${FAKE.pgpassPw}"\n`,
    hide: [FAKE.aws, FAKE.awsSecret, FAKE.mysqlPw, FAKE.pgpassPw],
    keep: ['region = eu-central-1', 'user = root', 'aws_secret_access_key = '],
  },
  {
    name: 'token shapes with no name around them',
    text: [FAKE.ghPat, FAKE.google, FAKE.slack, FAKE.stripe, FAKE.notion, FAKE.telegram, FAKE.aws, FAKE.anthropic, FAKE.openai].join(' | '),
    hide: [FAKE.ghPat, FAKE.google, FAKE.slack, FAKE.stripe, FAKE.notion, FAKE.telegram, FAKE.aws, FAKE.anthropic, FAKE.openai],
  },
  {
    name: 'python dict and YAML with secret keys',
    text: `cfg = {'host': 'db', 'password': '${FAKE.dbPassword}'}\nsmtp:\n  user: bot@example.org\n  app_password: ${FAKE.gmailApp}\n  client_secret: "${FAKE.sessionSecret}"\n`,
    hide: [FAKE.dbPassword, FAKE.gmailApp, FAKE.sessionSecret],
    keep: ["'host': 'db'", 'user: bot@example.org', 'app_password: ', 'client_secret: "'],
  },
  {
    name: 'CLI flag with a secret value',
    text: `$ deploy --api-key ${FAKE.jsonApiKey} --region eu --password=${FAKE.dbPassword}`,
    hide: [FAKE.jsonApiKey, FAKE.dbPassword],
    keep: ['--region eu', '--api-key ', '--password='],
  },
  {
    name: 'review F2: grep -rn / grep -n prefixes and diff lines in front of NAME=value',
    text: `./config/app.env:12:DB_PASSWORD=${FAKE.shape}\n12:API_TOKEN=${FAKE.shape}x\napp.env:SESSION_SECRET=${FAKE.shape}y\n@@ -1,2 +1,2 @@\n-DB_PASSWORD=${FAKE.shapeOld}\n+DB_PASSWORD=${FAKE.shape}z\n`,
    hide: [FAKE.shape, FAKE.shapeOld],
    keep: ['./config/app.env:12:DB_PASSWORD=', '@@ -1,2 +1,2 @@', '+DB_PASSWORD='],
  },
  {
    name: 'review F2: glued env names in a plain env dump (PGPASSWORD, SSHPASS, MYSQLPWD, GITHUBTOKEN, HTPASSWD)',
    text: `HOME=/root\nPGPASSWORD=${FAKE.shape}\nSSHPASS=${FAKE.shape}a\nMYSQLPWD=${FAKE.shape}b\nGITHUBTOKEN=${FAKE.shape}c\nHTPASSWD=${FAKE.shape}d\nPGPASSFILE=/root/.pgpass\n`,
    hide: [FAKE.shape],
    keep: ['HOME=/root', 'PGPASSFILE=/root/.pgpass'],
  },
  {
    name: 'review F2: CLI short flags (sshpass -p, registry login -p, redis-cli -a, ldapsearch -w, mongo -p, zip -P, curl -u, smbclient -U, openssl pass:)',
    text: [
      `: 1696400000:0;sshpass -p '${FAKE.shape}' ssh root@h`,
      `docker login -u app -p ${FAKE.shape}1 ghcr.io`,
      `redis-cli -h h -a ${FAKE.shape}2 ping`,
      `ldapsearch -x -D cn=admin -w ${FAKE.shape}3 -b dc=x`,
      `mongosh -u root -p ${FAKE.shape}4 --authenticationDatabase admin`,
      `zip -P ${FAKE.shape}5 out.zip a.txt`,
      `curl -u app:${FAKE.shape}6 https://api.example.com`,
      `smbclient //h/share -U app%${FAKE.shape}7`,
      `openssl enc -aes-256-cbc -pass pass:${FAKE.shape}8 -in a`,
      `mysql -uroot -p${FAKE.shape}9 shop`,
      '',
    ].join('\n'),
    hide: [FAKE.shape],
    keep: ['sshpass -p ', 'docker login -u app -p ', 'redis-cli -h h -a ', 'curl -u app:', '-pass pass:', 'mysql -uroot -p'],
  },
  {
    name: 'review F2: PHP arrays, define(), getenv() defaults, Ruby symbols',
    text: [
      `'token' => '${FAKE.phpToken}',`,
      `"password" => "${FAKE.shape}",`,
      `define('DB_PASSWORD', '${FAKE.shape}a');`,
      `$k = getenv('API_KEY', '${FAKE.shape}b');`,
      `:password => '${FAKE.shape}c',`,
      '',
    ].join('\n'),
    hide: [FAKE.phpToken, FAKE.shape],
    keep: ["'token' => '", "define('DB_PASSWORD', '"],
  },
  {
    name: 'review F2: XML config (element, .NET appSettings, Java properties entry)',
    text: `<server><id>repo</id><username>app</username><password>${FAKE.shape}</password></server>\n<add key="DB_PASSWORD" value="${FAKE.shape}a" />\n<entry key="db.password">${FAKE.shape}b</entry>\n`,
    hide: [FAKE.shape],
    keep: ['<username>app</username>', '<add key="DB_PASSWORD" value="'],
  },
  {
    name: 'review F2: .npmrc of a custom registry, container Env value holding a quote',
    text: `//npm.example.com/:_authToken=${FAKE.npmrc}\n${JSON.stringify({ Env: [`POSTGRES_PASSWORD=${FAKE.quoted}`, 'PATH=/usr/bin'] })}\n`,
    hide: [FAKE.npmrc, 'Fake-99'],
    keep: ['//npm.example.com/:_authToken=', 'PATH=/usr/bin'],
  },
  {
    name: 'query-string token',
    text: `GET https://api.example.com/v1/items?limit=10&access_token=${FAKE.apiToken}&page=2`,
    hide: [FAKE.apiToken],
    keep: ['limit=10', '&page=2'],
  },
]

// ---------------------------------------------------------------------------
// Tool outputs: no secrets, must come back unchanged
// ---------------------------------------------------------------------------

export type CleanCase = { readonly name: string; readonly text: string }

export const CLEAN: readonly CleanCase[] = [
  {
    name: 'TS code typing password/token',
    text: [
      'interface Creds {',
      '  password: string;',
      '  token?: string | null;',
      '  apiKey: ApiKey;',
      '  secret: Secret',
      '}',
      'const cfg = { password: process.env.DB_PASSWORD, token: config.get("token"), secret: this.secret, apiKey: apiKey };',
      'function login(password: string, token: string): Promise<{ accessToken: string }> {}',
      'const headers = { Authorization: `Bearer ${token}` };',
      '  private readonly token: string;',
      '  @Column() password_hash!: string',
      "const token = req.headers['authorization']?.split(' ')[1];",
    ].join('\n'),
  },
  {
    name: 'process.env.DB_PASSWORD in code',
    text: "const pw = process.env.DB_PASSWORD ?? ''\nconst url = `postgres://app:${process.env.DB_PASSWORD}@db/app`\n  password: process.env.PASSWORD,\n",
  },
  { name: '.env.example placeholders (battery: cat .env.example)', text: ENV_EXAMPLE },
  {
    name: 'spaced assignments in code stay (the INI rule leaves the right side when it is code)',
    text: [
      "password = request.form['password']", 'token = get_token()', 'secret = config.secret', 'this.token = token;',
      "password = os.environ['DB_PASSWORD']", 'secret = None', "password = 'changeme'", 'max_tokens = 4096',
      '    password = hashlib.sha256(raw).hexdigest()', 'secret_key = settings.SECRET_KEY', 'SECRET_KEY = env("SECRET_KEY")',
      'password = "${DB_PASSWORD}"', 'token_ttl = 3600', 'password == other', 'access_key = var.access_key',
      'secret = secrets.token_hex(32)', 'token = await getToken()', 'password = kwargs.get("password")', '',
    ].join('\n'),
  },
  {
    name: "names-only listing (battery: grep -o '^[A-Z_]*' .env, cut -d= -f1, awk -F=)",
    text: 'NODE_ENV\nPORT\nLOG_LEVEL\nFILES_DIR\nDATABASE_URL\nDB_PASSWORD\nGMAIL_APP_PASSWORD\nTELEGRAM_BOT_TOKEN\nOPENAI_API_KEY\nSESSION_SECRET\n',
  },
  {
    name: 'git diff of code naming token variables',
    text: [
      'diff --git a/src/auth/auth.guard.ts b/src/auth/auth.guard.ts',
      'index 3f2a9c1..8b7d6e5 100644',
      '--- a/src/auth/auth.guard.ts',
      '+++ b/src/auth/auth.guard.ts',
      '@@ -10,7 +10,9 @@ export class AuthGuard {',
      '-    const token = req.headers.authorization',
      '+    const accessToken = this.extractBearerToken(req)',
      "+    if (!accessToken) throw new UnauthorizedException('token missing')",
      '+    const refreshToken = await this.tokens.issue(user.id, { secret: this.jwtSecret })',
      '     return true',
    ].join('\n'),
  },
  {
    name: 'ls / stat of credential files (battery: ls -la .credentials.json, stat -c %s .env)',
    text: '-rw-------  1 alice  staff  471 Oct  4 10:00 /home/fake/.claude/.credentials.json\n-rw-------  1 alice staff 411 Sep 28 13:24 id_ed25519\n-rw-r--r--  1 alice staff  98 Sep 28 13:24 id_ed25519.pub\n376 /srv/app/.env\n',
  },
  { name: 'printenv | cut -d= -f1 (battery: compgen -v)', text: 'HOME\nPATH\nGEMINI_API_KEY\nCLAUDE_CODE_MESSAGING_TOKEN\nTERM\n' },
  {
    name: 'docker ps and docker inspect without secrets (battery FP: docker inspect)',
    text: 'CONTAINER ID   IMAGE         STATUS\nf00ba4         postgres:16   Up 3 hours\n' + JSON.stringify([{ Config: { Env: ['PATH=/usr/local/bin', 'NODE_VERSION=22.1.0', 'YARN_VERSION=1.22.19', 'TZ=Europe/Kyiv'] }, State: { Status: 'running', Health: { Status: 'healthy' } } }], null, 2),
  },
  {
    name: 'python code with password/token parameters',
    text: "def connect(password=None, token=None):\n    client = Client(api_key=api_key, secret=self.secret)\n    password = getpass.getpass()\n    TOKEN_URL = 'https://oauth2.googleapis.com/token'\n    max_tokens = 100000\n    session_key=session_key\n",
  },
  {
    name: 'docker-compose with ${VAR} references',
    text: 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}\n      POSTGRES_USER: acme\n    secrets:\n      - db_password\nsecrets:\n  db_password:\n    file: ./secrets/db_password.txt\n',
  },
  { name: 'GitHub Actions secret reference', text: '      - run: psql\n        env:\n          PGPASSWORD: ${{ secrets.DB_PASSWORD }}\n          password: ${{ secrets.PASS }}\n' },
  { name: 'README prose naming variables', text: 'Put the token into .env as TELEGRAM_BOT_TOKEN=<token> and the password into DB_PASSWORD.\nThe access_token expires in 3600 s; refresh_token is rotated on every use.\n' },
  { name: 'JSON schema with password/token properties', text: JSON.stringify({ properties: { password: { type: 'string', minLength: 8 }, token: { type: 'string' } }, required: ['password'] }, null, 2) },
  { name: 'package.json script with --env-file (battery FP: node --env-file)', text: JSON.stringify({ scripts: { start: 'node --env-file-if-exists=.env dist/main.js', test: 'vitest' } }, null, 2) },
  { name: 'k8s Deployment referencing a secret', text: 'env:\n  - name: DB_PASSWORD\n    valueFrom:\n      secretKeyRef:\n        name: acme-db\n        key: password\n' },
  { name: 'argparse help with metavars', text: 'usage: tool [-h] [--token TOKEN] [--api-key API_KEY] [--client-secret CLIENT_SECRET]\n  --password PASSWORD  database password\n' },
  { name: 'grep autoCompact ~/.claude.json (old false block)', text: '  "autoCompactEnabled": true,\n  "autoCompactWindow": 300000,\n' },
  { name: 'claude mcp list without secrets', text: 'github: npx -y @modelcontextprotocol/server-github - ✓ Connected\nnotion: https://mcp.notion.com/mcp (HTTP) - ✓ Connected\n' },
  { name: 'request ids and hashes', text: 'req_id=550e8400-e29b-41d4-a716-446655440000 commit 3f2a9c1e8b7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f\nsha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n' },
  { name: '.npmrc token reference', text: '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nregistry=https://registry.npmjs.org/\n' },
  { name: 'SQL with password_hash and reset', text: "UPDATE users SET password_hash = $1 WHERE id = $2;\n-- password reset requested for user 42\nSELECT token_type, expires_at FROM oauth_tokens;\n" },
  { name: 'ssh-keygen fingerprint of a public key (battery FP: cat id_x.pub)', text: '256 SHA256:Gz3o0Yb7xFakeFingerprintValue0123456789abcd app@mac (ED25519)\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyMaterial0123456789abcdefgh app@mac\n' },
  { name: 'acme-env check output (names, lengths, verdicts)', text: 'DB_PASSWORD           len=16  ok\nGMAIL_APP_PASSWORD    len=19  ok\nTELEGRAM_BOT_TOKEN    missing\n' },
  { name: 'Node one-liner reading a non-secret variable (battery FP: process.env.PORT)', text: '3000\n' },
  { name: 'real corpus FP: access-note labels printed in docs', text: 'tunnel hides (`app_setting`, `app_user*`, `app_api*`)\nvalues via bin/acme-env; GitHub `AliceFake2024Handle`; -o ServerAliveInterval=30; user `acme_ro` on `stand`, login app\n' },
  { name: 'real corpus FP: a header described in a comment', text: '  // Authorization: Basic <b64> / Bearer <token>. A plain word («Basic authentication») is not a credential.\n' },
  { name: 'real corpus FP: a flag followed by prose', text: 'deny "glab auth --show-token prints the GitLab token"\nrun with --token file or --password prompt\n' },
  { name: 'real corpus FP: pass and password in prose under a netrc-looking file', text: 'All-files counts in one pass: 13 files\nmachine learning notes\nthe database stays on the old password until the role is synced\npass=0; fail=0\n' },
  { name: 'real corpus FP: token counts and labels in code', text: "  tokens: 100_000,\n  max_tokens: 4_096,\n/** source token: \"user_typed\" | \"trigger_fire\" */\nconst kind = /cookie/i.test(name) ? 'cookie' : name.toLowerCase()\n" },
  { name: 'real corpus FP: a URL with a user only, and a placeholder password', text: '#   DATABASE_URL=postgres://acme@127.0.0.1:5435/acme\n// scheme://user:pass@host and https://user:password@example.com\n' },
  {
    name: 'review F2 guards: the same CLIs and shapes without a secret',
    text: [
      'mysql -p shop', 'ssh -p 2222 root@h', 'docker run -p 8080:80 nginx', 'redis-cli -a "$REDIS_PASSWORD" ping',
      'curl -u "$USER:$PASS" https://x', 'zip -r out.zip dir', 'openssl enc -pass env:PW -in a', 'sshpass -e ssh h',
      "<password>${DB_PASSWORD}</password>", "'password' => env('DB_PASSWORD'),", "define('DB_PASSWORD', getenv('DB_PASSWORD'));",
      "src/auth.ts:12:  const password = req.body.password", '+  password = form.password', 'htpasswd: /etc/nginx/.htpasswd',
      "t('password', 'Пароль')", "'token' => $request->token,", 'PGPASSFILE=/root/.pgpass', 'grep -rn "token" src/',
      '',
    ].join('\n'),
  },
  { name: 'heredoc / commit messages mentioning eval and env (battery FP)', text: "hooks: fix\n\nMemory: none, covered by the hook's test set\nwe never call eval\nvalues to export\n" },
]
