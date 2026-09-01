import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const allowedPermissions = new Set(['customization', 'templates', 'accounts']);
const defaultOrganizationId = 'org_default';
const defaultOrganizationName = '默认组织';

function usage() {
  console.log(`Usage:
  npm run accounts:upsert -- --username test --password 'new-password'
  npm run accounts:upsert -- --db /root/auth-db.json --username test --password 'new-password' --permissions customization,templates

Options:
  --db <file>                 auth-db.json path, default AUTH_DB_PATH or ./.data/auth-db.json
  --username <name>           account username
  --password <password>       new password, required when creating or changing password
  --permissions <list|all>    comma-separated permissions, default customization,templates
  --organization-id <id>      organization to join, can be repeated, default org_default
  --active <true|false>       set account active flag, default true
  --keep-sessions             keep existing sessions when changing password
`);
}

function parseArgs(argv) {
  const args = {
    db: process.env.AUTH_DB_PATH ?? './.data/auth-db.json',
    permissions: ['customization', 'templates'],
    organizationIds: [],
    active: true,
    keepSessions: false
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--keep-sessions') {
      args.keepSessions = true;
      continue;
    }
    const next = argv[++index];
    if (next === undefined) throw new Error(`Missing value for ${arg}`);
    if (arg === '--db') args.db = next;
    else if (arg === '--username') args.username = next.trim();
    else if (arg === '--password') args.password = next;
    else if (arg === '--permissions') args.permissions = parsePermissions(next);
    else if (arg === '--organization-id') args.organizationIds.push(next.trim());
    else if (arg === '--active') args.active = parseBoolean(next);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (args.help) return args;
  if (!args.username) throw new Error('Missing --username');
  if (args.username.length < 3 || args.username.length > 40)
    throw new Error('--username length must be 3-40 characters');
  if (args.password !== undefined && (args.password.length < 10 || args.password.length > 128))
    throw new Error('--password length must be 10-128 characters');
  args.organizationIds = [...new Set(args.organizationIds.filter(Boolean))];
  if (!args.organizationIds.length) args.organizationIds = [defaultOrganizationId];
  return args;
}

function parseBoolean(value) {
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error('--active must be true or false');
}

function parsePermissions(value) {
  if (value.trim().toLowerCase() === 'all') return [...allowedPermissions];
  const permissions = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const permission of permissions) {
    if (!allowedPermissions.has(permission)) throw new Error(`Unknown permission: ${permission}`);
  }
  return [...new Set(permissions)];
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto
    .createHash('sha256')
    .update(salt + password)
    .digest('hex');
  return {salt, passwordHash};
}

async function readState(filePath) {
  try {
    return normalizeState(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return normalizeState({
        nextUserId: 1,
        users: [],
        sessions: [],
        templates: [],
        organizations: [],
        userOrganizations: []
      });
    }
    throw error;
  }
}

function normalizeState(state) {
  const now = Date.now();
  const normalized = {
    nextUserId: Number(state.nextUserId ?? 1),
    users: Array.isArray(state.users) ? state.users : [],
    sessions: Array.isArray(state.sessions) ? state.sessions : [],
    templates: Array.isArray(state.templates) ? state.templates : [],
    organizations: Array.isArray(state.organizations) ? state.organizations : [],
    userOrganizations: Array.isArray(state.userOrganizations) ? state.userOrganizations : []
  };
  if (!normalized.organizations.length) {
    normalized.organizations.push({
      id: defaultOrganizationId,
      name: defaultOrganizationName,
      created_at: now,
      updated_at: now
    });
  }
  const maxUserId = normalized.users.reduce((max, user) => Math.max(max, Number(user.id) || 0), 0);
  normalized.nextUserId = Math.max(normalized.nextUserId, maxUserId + 1);
  return normalized;
}

function ensureOrganizations(state, organizationIds) {
  const now = Date.now();
  for (const id of organizationIds) {
    if (!state.organizations.some((organization) => organization.id === id)) {
      state.organizations.push({
        id,
        name: id === defaultOrganizationId ? defaultOrganizationName : id,
        created_at: now,
        updated_at: now
      });
    }
  }
}

function upsertUser(state, args) {
  const now = Date.now();
  ensureOrganizations(state, args.organizationIds);
  let user = state.users.find(
    (item) => String(item.username).toLowerCase() === args.username.toLowerCase()
  );
  const created = !user;
  if (created) {
    if (!args.password) throw new Error('Creating an account requires --password');
    const {salt, passwordHash} = hashPassword(args.password);
    user = {
      id: state.nextUserId++,
      username: args.username,
      password_hash: passwordHash,
      salt,
      permissions: JSON.stringify(args.permissions),
      active: args.active ? 1 : 0,
      created_at: now
    };
    state.users.push(user);
  } else {
    user.permissions = JSON.stringify(args.permissions);
    user.active = args.active ? 1 : 0;
    if (args.password !== undefined) {
      const {salt, passwordHash} = hashPassword(args.password);
      user.password_hash = passwordHash;
      user.salt = salt;
      if (!args.keepSessions) {
        state.sessions = state.sessions.filter((session) => Number(session.user_id) !== user.id);
      }
    }
  }

  state.userOrganizations = state.userOrganizations.filter((item) => item.user_id !== user.id);
  for (const organizationId of args.organizationIds) {
    state.userOrganizations.push({
      user_id: user.id,
      organization_id: organizationId,
      created_at: now
    });
  }
  return {created, user};
}

async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  const backup = `${filePath}.before-user-upsert-${new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-')}.bak`;
  await fs.copyFile(filePath, backup).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  return backup;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const dbPath = path.resolve(args.db);
  const state = await readState(dbPath);
  const result = upsertUser(state, args);
  const backup = await writeState(dbPath, state);
  console.log(`${result.created ? 'Created' : 'Updated'} user: ${result.user.username}`);
  console.log(`User id: ${result.user.id}`);
  console.log(`Permissions: ${result.user.permissions}`);
  console.log(`Organizations: ${args.organizationIds.join(',')}`);
  console.log(`DB: ${dbPath}`);
  console.log(`Backup: ${backup}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  usage();
  process.exit(1);
});
