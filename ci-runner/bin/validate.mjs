// Strict allowlists also keep shell, Dockerfile and Compose interpolation out of project data.
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const MEMORY = /^[1-9]\d*(?:b|k|m|g|kb|mb|gb)?$/i;

function demand(ok, path, reason) {
  if (!ok) throw new Error(`runner.json: ${path}: ${reason}`);
}

function object(value, path, keys) {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value), path, 'expected an object');
  for (const key of Object.keys(value)) demand(keys.includes(key), `${path}.${key}`, 'unknown field');
}

function string(value, path, pattern, reason) {
  demand(typeof value === 'string' && pattern.test(value), path, reason);
}

function number(value, path, minimum, maximum = Infinity, integer = false) {
  demand(typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    && (!integer || Number.isInteger(value)), path, `expected ${integer ? 'an integer' : 'a number'} in [${minimum}, ${maximum}]`);
}

function strings(value, path, pattern) {
  demand(Array.isArray(value), path, 'expected an array');
  value.forEach((item, index) => string(item, `${path}[${index}]`, pattern, 'invalid value'));
  demand(new Set(value).size === value.length, path, 'duplicate values');
}

export function validateHost(host) {
  string(host, 'host / CI_RUNNER_HOST', /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/, 'expected an SSH alias or [user@]hostname');
}

function validateLimits(limits, path) {
  object(limits, path, ['cpuset', 'cpus', 'cpuShares', 'mem', 'oomScoreAdj', 'pids', 'shm']);
  string(limits.mem, `${path}.mem`, MEMORY, 'expected a positive Docker memory size, e.g. 1536m');
  if (limits.cpuset !== undefined) string(limits.cpuset, `${path}.cpuset`, /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/, 'expected CPUs, e.g. 2,3 or 0-2');
  if (limits.cpuset !== undefined) validateCpuSet(limits.cpuset, `${path}.cpuset`);
  if (limits.cpus !== undefined) number(limits.cpus, `${path}.cpus`, Number.MIN_VALUE);
  if (limits.cpuShares !== undefined) number(limits.cpuShares, `${path}.cpuShares`, 2, 262144, true);
  if (limits.oomScoreAdj !== undefined) number(limits.oomScoreAdj, `${path}.oomScoreAdj`, -1000, 1000, true);
  if (limits.pids !== undefined) number(limits.pids, `${path}.pids`, 1, Number.MAX_SAFE_INTEGER, true);
  if (limits.shm !== undefined) string(limits.shm, `${path}.shm`, MEMORY, 'expected a positive Docker memory size');
}

function validateCpuSet(value, path) {
  for (const range of value.split(',')) {
    const [first, last = first] = range.split('-').map(Number);
    demand(Number.isSafeInteger(first) && Number.isSafeInteger(last) && first <= last, path, 'invalid CPU range');
  }
}

// Preserve the original main/light service and volume names without adding deployment IDs to the schema.
export function serviceName(runner, index, runners) {
  if (index === 0) return 'runner';
  const prefix = `${runners[0].name}-`;
  return `runner-${runner.name.startsWith(prefix) ? runner.name.slice(prefix.length) : runner.name}`;
}

function validateRunners(config) {
  demand(Array.isArray(config.runners) && config.runners.length > 0, 'runners', 'expected a non-empty array');
  config.runners.forEach((runner, index) => {
    const path = `runners[${index}]`;
    object(runner, path, ['name', 'labels', 'limits', 'testDb']);
    string(runner.name, `${path}.name`, NAME, 'expected a runner name (1–64 letters, digits, dots, underscores, hyphens)');
    strings(runner.labels, `${path}.labels`, NAME);
    demand(runner.labels.length > 0, `${path}.labels`, 'expected at least one label');
    validateLimits(runner.limits, `${path}.limits`);
    demand(runner.testDb === undefined || runner.testDb === true, `${path}.testDb`, 'only true or omission is allowed');
    demand(!runner.testDb || config.testDb !== undefined, `${path}.testDb`, 'requires top-level testDb');
  });
  demand(new Set(config.runners.map((r) => r.name)).size === config.runners.length, 'runners', 'duplicate runner names');
  const services = config.runners.map((r, i) => serviceName(r, i, config.runners));
  demand(new Set(services).size === services.length, 'runners', 'names produce duplicate Compose services');
}

function validateDatabase(config) {
  if (config.testDb === undefined) return;
  const db = config.testDb;
  object(db, 'testDb', ['image', 'port', 'user', 'db', 'cpus', 'mem']);
  string(db.image, 'testDb.image', /^[a-zA-Z0-9][a-zA-Z0-9./_:-]*(?:@sha256:[a-fA-F0-9]{64})?$/, 'expected a Docker image reference');
  number(db.port, 'testDb.port', 1, 65535, true);
  for (const key of ['user', 'db']) string(db[key], `testDb.${key}`, /^[a-zA-Z_][a-zA-Z0-9_]*$/, 'expected a PostgreSQL identifier');
  number(db.cpus, 'testDb.cpus', Number.MIN_VALUE);
  string(db.mem, 'testDb.mem', MEMORY, 'expected a positive Docker memory size');
  demand(config.runners.some((r) => r.testDb), 'testDb', 'requires at least one runner with testDb: true');
}

function validateFeatures(config) {
  strings(config.extraApt === undefined ? [] : config.extraApt, 'extraApt', /^[a-z0-9][a-z0-9+.-]*$/);
  strings(config.features === undefined ? [] : config.features, 'features', /^playwright$/);
  for (const key of ['playwrightVersion', 'nodeVersion', 'nodeSha256']) {
    if ((config.features ?? []).includes('playwright')) {
      string(config[key], key, key.endsWith('Sha256') ? SHA256 : VERSION, 'playwright requires an exact version / 64-digit SHA256');
    } else demand(config[key] === undefined, key, 'requires features: ["playwright"]');
  }
}

export function validate(config) {
  object(config, 'config', ['repo', 'host', 'dir', 'composeName', 'runners', 'testDb', 'extraApt', 'features',
    'playwrightVersion', 'nodeVersion', 'nodeSha256', 'runnerVersion', 'runnerSha256']);
  string(config.repo, 'repo', /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/, 'expected owner/name');
  validateHost(config.host);
  string(config.dir, 'dir', /^\/[a-zA-Z0-9_. -]+(?:\/[a-zA-Z0-9_. -]+)*$/, 'expected an absolute server directory (spaces allowed)');
  demand(!config.dir.split('/').some((p) => p === '.' || p === '..'), 'dir', 'dot path segments are forbidden');
  string(config.composeName, 'composeName', /^[a-z0-9][a-z0-9_-]*$/, 'expected a lowercase Compose project name');
  string(config.runnerVersion, 'runnerVersion', VERSION, 'expected an exact version, e.g. 2.338.2');
  string(config.runnerSha256, 'runnerSha256', SHA256, 'expected a 64-digit SHA256');
  validateRunners(config);
  validateDatabase(config);
  validateFeatures(config);
  return config;
}
