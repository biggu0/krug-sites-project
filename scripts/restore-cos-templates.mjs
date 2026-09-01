import fs from 'node:fs/promises';
import path from 'node:path';

const defaultRegions = {
  cover: {
    x: 4.4,
    y: 3.1,
    width: 91.2,
    height: 61.4,
    curve: 0,
    points: [
      {x: 4.4, y: 3.1},
      {x: 95.6, y: 3.1},
      {x: 95.6, y: 64.5},
      {x: 4.4, y: 64.5}
    ]
  },
  inner: {
    x: 4.4,
    y: 3.1,
    width: 91.2,
    height: 50.5,
    curve: 0,
    points: [
      {x: 4.4, y: 3.1},
      {x: 95.6, y: 3.1},
      {x: 95.6, y: 53.2},
      {x: 88, y: 53.5},
      {x: 78, y: 51.8},
      {x: 68, y: 49.3},
      {x: 58, y: 46.8},
      {x: 50, y: 45.8},
      {x: 42, y: 46.2},
      {x: 32, y: 47.8},
      {x: 22, y: 49.8},
      {x: 12, y: 51.8},
      {x: 4.4, y: 53.2}
    ]
  }
};

const defaultState = {
  nextUserId: 1,
  users: [],
  sessions: [],
  templates: [],
  organizations: [],
  userOrganizations: []
};

function usage() {
  console.log(`Usage:
  node scripts/restore-cos-templates.mjs --csv /path/cos-object-list.csv --db ./.data/auth-db.json
  node scripts/restore-cos-templates.mjs --csv /path/cos-object-list.csv --db /tmp/auth-db.json --apply

Options:
  --csv <file>              COS object list CSV exported from Tencent Cloud
  --db <file>               auth-db.json path, default AUTH_DB_PATH or ./.data/auth-db.json
  --prefix <prefix>         COS object prefix, default calendar/prod/uploads/
  --organization-id <id>    target organization, default org_default
  --page-count <number>     recovered template page count, default 13
  --page-mode <all|odd|even> default all
  --duplex                  mark recovered templates as duplex
  --replace-existing        update rows with the same id or normalized name
  --apply                   write auth-db.json; without this it only prints a dry run
`);
}

function parseArgs(argv) {
  const args = {
    db: process.env.AUTH_DB_PATH ?? './.data/auth-db.json',
    prefix: 'calendar/prod/uploads/',
    organizationId: 'org_default',
    pageCount: 13,
    pageMode: 'all',
    duplex: false,
    replaceExisting: false,
    apply: false
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--duplex') {
      args.duplex = true;
      continue;
    }
    if (arg === '--replace-existing') {
      args.replaceExisting = true;
      continue;
    }
    const next = argv[++index];
    if (next === undefined) throw new Error(`Missing value for ${arg}`);
    if (arg === '--csv') args.csv = next;
    else if (arg === '--db') args.db = next;
    else if (arg === '--prefix') args.prefix = next;
    else if (arg === '--organization-id') args.organizationId = next;
    else if (arg === '--page-count') args.pageCount = Number(next);
    else if (arg === '--page-mode') args.pageMode = next;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (args.help) return args;
  if (!args.csv) throw new Error('Missing --csv');
  if (!Number.isInteger(args.pageCount) || ![12, 13, 24, 25].includes(args.pageCount))
    throw new Error('--page-count must be 12, 13, 24, or 25');
  if (!['all', 'odd', 'even'].includes(args.pageMode))
    throw new Error('--page-mode must be all, odd, or even');
  if (args.duplex && args.pageMode === 'all')
    throw new Error('--duplex requires --page-mode odd or even');
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [],
    value = '',
    quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index++) {
    const char = input[index],
      next = input[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        index++;
      } else if (char === '"') quoted = false;
      else value += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (char !== '\r') value += char;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((item) => item.some((cell) => cell.trim()));
}

function cleanSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
}

function normalizePrefix(value) {
  return cleanSegment(value).replace(/\/?$/, '/');
}

function normalizedName(value) {
  return value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.pdf$/i, '')
    .trim()
    .toLowerCase();
}

function templateName(fileName) {
  return path.basename(fileName).replace(/\.pdf$/i, '');
}

function objectFromUrl(rawUrl, prefix) {
  const url = new URL(rawUrl);
  const decoded = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!decoded.startsWith(prefix)) return undefined;
  const relative = decoded.slice(prefix.length);
  const [id, ...parts] = relative.split('/');
  if (!/^tpl_/i.test(id) || !parts.length) return undefined;
  return {id, objectKey: relative, fileName: parts.join('/')};
}

function readObjects(rows, prefix) {
  const header = rows[0].map((value) => value.trim());
  const nameIndex = header.findIndex((value) => value === '文件名' || /file.?name/i.test(value));
  const urlIndex = header.findIndex((value) => value === '文件URL' || /url/i.test(value));
  if (nameIndex < 0 || urlIndex < 0) throw new Error('CSV must contain 文件名 and 文件URL columns');
  const groups = new Map();
  for (const row of rows.slice(1)) {
    const rawUrl = row[urlIndex]?.trim();
    if (!rawUrl) continue;
    let object;
    try {
      object = objectFromUrl(rawUrl, prefix);
    } catch {
      continue;
    }
    if (!object) continue;
    const fileName = row[nameIndex]?.trim() || object.fileName;
    const files = groups.get(object.id) ?? [];
    files.push({...object, fileName});
    groups.set(object.id, files);
  }
  return groups;
}

function chooseTemplateFiles(groups) {
  const warnings = [];
  const templates = [];
  for (const [id, files] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const pdfs = files.filter((file) => /\.pdf$/i.test(file.fileName));
    const foregrounds = pdfs.filter((file) => /-foreground\.pdf$/i.test(file.fileName));
    const candidates = pdfs.filter((file) => !/-foreground\.pdf$/i.test(file.fileName));
    if (!candidates.length) {
      warnings.push(`${id}: no template PDF found`);
      continue;
    }
    const preferred =
      candidates.find((file) => !/^未标题/i.test(path.basename(file.fileName))) ?? candidates[0];
    if (candidates.length > 1)
      warnings.push(`${id}: multiple template PDFs, using ${preferred.fileName}`);
    const foreground =
      foregrounds.find((file) => file.fileName.startsWith(preferred.fileName)) ?? foregrounds[0];
    templates.push({id, file: preferred, foreground});
  }
  return {templates, warnings};
}

async function readState(filePath) {
  try {
    return {...defaultState, ...JSON.parse(await fs.readFile(filePath, 'utf8'))};
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(defaultState);
    throw error;
  }
}

async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  const backup = `${filePath}.before-cos-restore-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}.bak`;
  await fs.copyFile(filePath, backup).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  return backup;
}

function ensureDefaultOrganization(state, organizationId) {
  const now = Date.now();
  state.organizations = Array.isArray(state.organizations) ? state.organizations : [];
  if (!state.organizations.some((item) => item.id === organizationId)) {
    state.organizations.push({
      id: organizationId,
      name: organizationId === 'org_default' ? '默认组织' : organizationId,
      created_at: now,
      updated_at: now
    });
  }
}

function buildRows(items, args) {
  const now = Date.now();
  return items.map((item) => ({
    id: item.id,
    organization_id: args.organizationId,
    normalized_name: normalizedName(templateName(item.file.fileName)),
    name: templateName(item.file.fileName),
    file_name: item.file.fileName,
    object_key: item.file.objectKey,
    foreground_file_name: item.foreground?.fileName ?? null,
    foreground_object_key: item.foreground?.objectKey ?? null,
    regions: JSON.stringify(defaultRegions),
    has_cover: 1,
    page_count: args.pageCount,
    page_mode: args.pageMode,
    duplex: args.duplex ? 1 : 0,
    rotate_cover: 0,
    rotate_inner: 0,
    created_at: now,
    updated_at: now
  }));
}

function mergeTemplates(state, rows, replaceExisting) {
  state.templates = Array.isArray(state.templates) ? state.templates : [];
  const inserted = [],
    updated = [],
    skipped = [];
  for (const row of rows) {
    const sameId = state.templates.findIndex((item) => item.id === row.id);
    const sameName = state.templates.findIndex(
      (item) =>
        (item.organization_id || 'org_default') === row.organization_id &&
        item.normalized_name === row.normalized_name
    );
    const index = sameId >= 0 ? sameId : sameName;
    if (index >= 0) {
      if (!replaceExisting) {
        skipped.push(row);
        continue;
      }
      state.templates[index] = {
        ...state.templates[index],
        ...row,
        created_at: state.templates[index].created_at ?? row.created_at
      };
      updated.push(row);
      continue;
    }
    state.templates.push(row);
    inserted.push(row);
  }
  return {inserted, updated, skipped};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const csvPath = path.resolve(args.csv),
    dbPath = path.resolve(args.db),
    prefix = normalizePrefix(args.prefix);
  const rows = parseCsv(await fs.readFile(csvPath, 'utf8'));
  const groups = readObjects(rows, prefix);
  const {templates, warnings} = chooseTemplateFiles(groups);
  const state = await readState(dbPath);
  ensureDefaultOrganization(state, args.organizationId);
  const mergeResult = mergeTemplates(state, buildRows(templates, args), args.replaceExisting);

  console.log(`CSV: ${csvPath}`);
  console.log(`DB: ${dbPath}`);
  console.log(`COS prefix: ${prefix}`);
  console.log(`Template directories: ${groups.size}`);
  console.log(
    `Prepared: ${templates.length}, inserted: ${mergeResult.inserted.length}, updated: ${mergeResult.updated.length}, skipped: ${mergeResult.skipped.length}`
  );
  for (const warning of warnings) console.warn(`WARN: ${warning}`);
  if (mergeResult.skipped.length)
    console.warn('WARN: some templates already exist; use --replace-existing to update them');

  if (!args.apply) {
    console.log('Dry run only. Add --apply to write auth-db.json.');
    return;
  }

  const backup = await writeState(dbPath, state);
  console.log(`Wrote ${dbPath}`);
  console.log(`Backup: ${backup}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  usage();
  process.exit(1);
});
