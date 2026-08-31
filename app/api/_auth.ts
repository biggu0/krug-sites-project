export type Permission='customization'|'templates'|'accounts';
export type Organization={id:string;name:string;createdAt:number;updatedAt:number};
export type SessionUser={id:number;username:string;permissions:Permission[];organizations:Organization[];organizationIds:string[]};

type UserRow={id:number;username:string;password_hash:string;salt:string;permissions:string;active:number;created_at:number};
type SessionRow={token_hash:string;user_id:number;expires_at:number;created_at:number};
type OrganizationRow={id:string;name:string;created_at:number;updated_at:number};
type UserOrganizationRow={user_id:number;organization_id:string;created_at:number};
type TemplateRow={id:string;organization_id?:string|null;normalized_name:string;name:string;file_name:string;object_key:string;foreground_file_name?:string|null;foreground_object_key?:string|null;regions?:string|null;has_cover?:number|null;page_count?:number|null;page_mode?:string|null;duplex?:number|null;rotate_cover?:number|null;rotate_inner?:number|null;created_at:number;updated_at:number};
type LocalState={nextUserId:number;users:UserRow[];sessions:SessionRow[];templates:TemplateRow[];organizations:OrganizationRow[];userOrganizations:UserOrganizationRow[]};
type QueryResult<T=unknown>={results:T[]};
type AuthStatement={bind:(...values:unknown[])=>AuthStatement;run:()=>Promise<{meta:{last_row_id?:number}}>;first:<T=unknown>()=>Promise<T|undefined>;all:<T=unknown>()=>Promise<QueryResult<T>>};
type AuthDb={prepare:(sql:string)=>AuthStatement;batch:(statements:AuthStatement[])=>Promise<unknown[]>};

const allowedPermissions:Permission[]=['customization','templates','accounts'];
const encoder=new TextEncoder();
let localDbPromise:Promise<AuthDb>|undefined;
export const defaultOrganizationId='org_default';
const defaultOrganizationName='默认组织';

function hex(bytes:ArrayBuffer|Uint8Array){return Array.from(new Uint8Array(bytes)).map(value=>value.toString(16).padStart(2,'0')).join('');}
function randomToken(bytes=32){const value=crypto.getRandomValues(new Uint8Array(bytes));return Array.from(value).map(item=>item.toString(16).padStart(2,'0')).join('');}
async function sha256(value:string){return hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));}

async function database():Promise<AuthDb>{
  try{
    const workers=await import('cloudflare:workers') as {env?:{DB?:AuthDb}};
    if(workers.env?.DB)return workers.env.DB;
  }catch{}
  return localDatabase();
}

async function localDatabase():Promise<AuthDb>{
  if(localDbPromise)return localDbPromise;
  localDbPromise=(async()=>{
    const fs=await import('node:fs/promises'),path=await import('node:path');
    const filePath=process.env.AUTH_DB_PATH??'./.data/auth-db.json';
    function normalizeState(state:Partial<LocalState>):LocalState{
      const now=Date.now();
      const organizations=state.organizations?.length?state.organizations:[{id:defaultOrganizationId,name:defaultOrganizationName,created_at:now,updated_at:now}];
      const organizationIds=new Set(organizations.map(item=>item.id));
      const users=state.users??[],templates=(state.templates??[]).map(template=>({...template,organization_id:template.organization_id||defaultOrganizationId}));
      const userOrganizations=[...(state.userOrganizations??[]).filter(item=>organizationIds.has(item.organization_id))];
      const assigned=new Set(userOrganizations.map(item=>`${item.user_id}:${item.organization_id}`));
      for(const user of users){
        const key=`${user.id}:${defaultOrganizationId}`;
        if(!assigned.has(key)){
          userOrganizations.push({user_id:user.id,organization_id:defaultOrganizationId,created_at:now});
          assigned.add(key);
        }
      }
      return{nextUserId:state.nextUserId??1,users,sessions:state.sessions??[],templates,organizations,userOrganizations};
    }
    async function read():Promise<LocalState>{try{return normalizeState(JSON.parse(await fs.readFile(filePath,'utf8')) as Partial<LocalState>);}catch{return normalizeState({nextUserId:1,users:[],sessions:[],templates:[]});}}
    async function write(state:LocalState){await fs.mkdir(path.dirname(filePath),{recursive:true});await fs.writeFile(filePath,JSON.stringify(state,null,2));}
    function statement(sql:string):AuthStatement{
      let values:unknown[]=[];
      const normalized=sql.replace(/\s+/g,' ').trim().toUpperCase();
      return{
        bind(...next){values=next;return this;},
        async run(){
          const state=await read();
          let lastRowId: number|undefined,dirty=false;
          if(normalized.startsWith('INSERT INTO USERS')){
            const username=String(values[0]);
            if(state.users.some(user=>user.username.toLowerCase()===username.toLowerCase()))throw new Error('UNIQUE constraint failed: users.username');
            lastRowId=state.nextUserId++;
            state.users.push({id:lastRowId,username,password_hash:String(values[1]),salt:String(values[2]),permissions:String(values[3]),active:1,created_at:Number(values[4])});
            dirty=true;
          }else if(normalized.startsWith('UPDATE USERS SET PERMISSIONS=')){
            const id=Number(values[2]),user=state.users.find(item=>item.id===id);
            if(user){user.permissions=String(values[0]);user.active=values[1]?1:0;dirty=true;}
          }else if(normalized.startsWith('UPDATE USERS SET PASSWORD_HASH=')){
            const id=Number(values[2]),user=state.users.find(item=>item.id===id);
            if(user){user.password_hash=String(values[0]);user.salt=String(values[1]);dirty=true;}
          }else if(normalized.startsWith('DELETE FROM USERS')){
            const id=Number(values[0]);
            state.users=state.users.filter(user=>user.id!==id);
            state.sessions=state.sessions.filter(session=>session.user_id!==id);
            state.userOrganizations=state.userOrganizations.filter(item=>item.user_id!==id);
            dirty=true;
          }else if(normalized.startsWith('INSERT INTO ORGANIZATIONS')){
            const row={id:String(values[0]),name:String(values[1]).trim(),created_at:Number(values[2]),updated_at:Number(values[3])};
            if(state.organizations.some(item=>item.name.toLowerCase()===row.name.toLowerCase()))throw new Error('UNIQUE constraint failed: organizations.name');
            state.organizations.push(row);
            dirty=true;
          }else if(normalized.startsWith('INSERT OR IGNORE INTO ORGANIZATIONS')){
            const row={id:String(values[0]),name:String(values[1]).trim(),created_at:Number(values[2]),updated_at:Number(values[3])};
            if(!state.organizations.some(item=>item.id===row.id)){
              state.organizations.push(row);
              dirty=true;
            }
          }else if(normalized.startsWith('UPDATE ORGANIZATIONS SET NAME=')){
            const id=String(values[2]),name=String(values[0]).trim(),organization=state.organizations.find(item=>item.id===id);
            if(organization){
              if(state.organizations.some(item=>item.id!==id&&item.name.toLowerCase()===name.toLowerCase()))throw new Error('UNIQUE constraint failed: organizations.name');
              organization.name=name;
              organization.updated_at=Number(values[1]);
              dirty=true;
            }
          }else if(normalized.startsWith('DELETE FROM ORGANIZATIONS')){
            const id=String(values[0]);
            state.organizations=state.organizations.filter(item=>item.id!==id);
            state.userOrganizations=state.userOrganizations.filter(item=>item.organization_id!==id);
            dirty=true;
          }else if(normalized.startsWith('DELETE FROM USER_ORGANIZATIONS WHERE USER_ID=')){
            const userId=Number(values[0]);
            state.userOrganizations=state.userOrganizations.filter(item=>item.user_id!==userId);
            dirty=true;
          }else if(normalized.startsWith('INSERT OR IGNORE INTO USER_ORGANIZATIONS')&&normalized.includes('SELECT ID')){
            const organizationId=String(values[0]),createdAt=Number(values[1]);
            for(const user of state.users){
              if(!state.userOrganizations.some(item=>item.user_id===user.id&&item.organization_id===organizationId)){
                state.userOrganizations.push({user_id:user.id,organization_id:organizationId,created_at:createdAt});
                dirty=true;
              }
            }
          }else if(normalized.startsWith('INSERT OR IGNORE INTO USER_ORGANIZATIONS')){
            const row={user_id:Number(values[0]),organization_id:String(values[1]),created_at:Number(values[2])};
            if(!state.userOrganizations.some(item=>item.user_id===row.user_id&&item.organization_id===row.organization_id)){
              state.userOrganizations.push(row);
              dirty=true;
            }
          }else if(normalized.startsWith('UPDATE TEMPLATES SET ORGANIZATION_ID=')){
            const organizationId=String(values[0]);
            for(const template of state.templates){
              if(!template.organization_id){
                template.organization_id=organizationId;
                dirty=true;
              }
            }
          }else if(normalized.startsWith('INSERT INTO SESSIONS')){
            state.sessions.push({token_hash:String(values[0]),user_id:Number(values[1]),expires_at:Number(values[2]),created_at:Number(values[3])});
            dirty=true;
          }else if(normalized.startsWith('DELETE FROM SESSIONS WHERE TOKEN_HASH=')){
            state.sessions=state.sessions.filter(session=>session.token_hash!==String(values[0]));
            dirty=true;
          }else if(normalized.startsWith('DELETE FROM SESSIONS WHERE USER_ID=')){
            const userId=Number(values[0]),keepUserId=Number(values[1]);
            state.sessions=state.sessions.filter(session=>!(session.user_id===userId&&session.user_id!==keepUserId));
            dirty=true;
          }else if(normalized.startsWith('INSERT INTO TEMPLATES')){
            const row:TemplateRow={id:String(values[0]),organization_id:String(values[1]),normalized_name:String(values[2]),name:String(values[3]),file_name:String(values[4]),object_key:String(values[5]),foreground_file_name:values[6]===undefined?null:String(values[6]),foreground_object_key:values[7]===undefined?null:String(values[7]),regions:values[8]===undefined?null:String(values[8]),has_cover:values[9]===undefined||values[9]===null?null:Number(values[9]),page_count:values[10]===undefined||values[10]===null?null:Number(values[10]),page_mode:values[11]===undefined||values[11]===null?null:String(values[11]),duplex:values[12]===undefined||values[12]===null?null:Number(values[12]),rotate_cover:values[13]===undefined||values[13]===null?null:Number(values[13]),rotate_inner:values[14]===undefined||values[14]===null?null:Number(values[14]),created_at:Number(values[15]),updated_at:Number(values[16])};
            if(state.templates.some(template=>(template.organization_id||defaultOrganizationId)===row.organization_id&&template.normalized_name===row.normalized_name))throw new Error('UNIQUE constraint failed: templates.organization_id, templates.normalized_name');
            state.templates.push(row);
            dirty=true;
          }else if(normalized.startsWith('UPDATE TEMPLATES SET NORMALIZED_NAME=')){
            const id=String(values[12]),template=state.templates.find(item=>item.id===id);
            if(template){
              const normalizedName=String(values[0]);
              const organizationId=template.organization_id||defaultOrganizationId;
              if(state.templates.some(item=>item.id!==id&&(item.organization_id||defaultOrganizationId)===organizationId&&item.normalized_name===normalizedName))throw new Error('UNIQUE constraint failed: templates.organization_id, templates.normalized_name');
              Object.assign(template,{normalized_name:normalizedName,name:String(values[1]),regions:values[2]===undefined||values[2]===null?null:String(values[2]),has_cover:values[3]===undefined||values[3]===null?null:Number(values[3]),page_count:values[4]===undefined||values[4]===null?null:Number(values[4]),page_mode:values[5]===undefined||values[5]===null?null:String(values[5]),duplex:values[6]===undefined||values[6]===null?null:Number(values[6]),rotate_cover:values[7]===undefined||values[7]===null?null:Number(values[7]),rotate_inner:values[8]===undefined||values[8]===null?null:Number(values[8]),foreground_file_name:values[9]===undefined?template.foreground_file_name:String(values[9]),foreground_object_key:values[10]===undefined?template.foreground_object_key:String(values[10]),updated_at:Number(values[11])});
              dirty=true;
            }
          }else if(normalized.startsWith('UPDATE TEMPLATES SET FOREGROUND_FILE_NAME=')){
            const id=String(values[3]),template=state.templates.find(item=>item.id===id);
            if(template){template.foreground_file_name=values[0]===undefined?null:String(values[0]);template.foreground_object_key=values[1]===undefined?null:String(values[1]);template.updated_at=Number(values[2]);dirty=true;}
          }else if(normalized.startsWith('DELETE FROM TEMPLATES WHERE ID=')){
            state.templates=state.templates.filter(template=>template.id!==String(values[0]));
            dirty=true;
          }
          if(dirty)await write(state);
          return{meta:{last_row_id:lastRowId}};
        },
        async first<T=unknown>(){
          const state=await read(),now=Number(values[1]);
          if(normalized.startsWith('SELECT COUNT(*) AS COUNT FROM USERS'))return{count:state.users.length} as T;
          if(normalized.startsWith('SELECT COUNT(*) AS COUNT FROM ORGANIZATIONS'))return{count:state.organizations.length} as T;
          if(normalized.startsWith('SELECT COUNT(*) AS COUNT FROM USER_ORGANIZATIONS WHERE ORGANIZATION_ID='))return{count:state.userOrganizations.filter(item=>item.organization_id===String(values[0])).length} as T;
          if(normalized.startsWith('SELECT COUNT(*) AS COUNT FROM TEMPLATES WHERE ORGANIZATION_ID='))return{count:state.templates.filter(item=>(item.organization_id||defaultOrganizationId)===String(values[0])).length} as T;
          if(normalized.startsWith('SELECT ID FROM ORGANIZATIONS WHERE ID=')){
            const organization=state.organizations.find(item=>item.id===String(values[0]));
            return organization?{id:organization.id} as T:undefined;
          }
          if(normalized.startsWith('SELECT ID FROM ORGANIZATIONS WHERE NAME=')){
            const name=String(values[0]).toLowerCase(),exclude=values[1]===undefined?undefined:String(values[1]);
            const organization=state.organizations.find(item=>item.name.toLowerCase()===name&&item.id!==exclude);
            return organization?{id:organization.id} as T:undefined;
          }
          if(normalized.startsWith('SELECT ID,PASSWORD_HASH,SALT,ACTIVE FROM USERS WHERE USERNAME=')){
            const user=state.users.find(item=>item.username.toLowerCase()===String(values[0]).toLowerCase());
            return user?{id:user.id,password_hash:user.password_hash,salt:user.salt,active:user.active} as T:undefined;
          }
          if(normalized.startsWith('SELECT USERS.ID, USERS.USERNAME, USERS.PERMISSIONS FROM SESSIONS JOIN USERS')){
            const session=state.sessions.find(item=>item.token_hash===String(values[0])&&item.expires_at>now);
            const user=session?state.users.find(item=>item.id===session.user_id&&item.active===1):undefined;
            return user?{id:user.id,username:user.username,permissions:user.permissions} as T:undefined;
          }
          if(normalized.startsWith('SELECT * FROM TEMPLATES WHERE ID='))return state.templates.find(item=>item.id===String(values[0])) as T|undefined;
          if(normalized.startsWith('SELECT ID FROM TEMPLATES WHERE ORGANIZATION_ID=')){
            const organizationId=String(values[0]),name=String(values[1]),exclude=values[2]===undefined?undefined:String(values[2]);
            return state.templates.find(item=>(item.organization_id||defaultOrganizationId)===organizationId&&item.normalized_name===name&&item.id!==exclude) as T|undefined;
          }
          if(normalized.startsWith('SELECT ID FROM TEMPLATES WHERE NORMALIZED_NAME=')){
            const name=String(values[0]),exclude=values[1]===undefined?undefined:String(values[1]);
            return state.templates.find(item=>item.normalized_name===name&&item.id!==exclude) as T|undefined;
          }
          return undefined;
        },
        async all<T=unknown>(){
          const state=await read();
          if(normalized.startsWith('SELECT ID,USERNAME,PERMISSIONS,ACTIVE,CREATED_AT FROM USERS ORDER BY ID'))return{results:[...state.users].sort((a,b)=>a.id-b.id).map(({id,username,permissions,active,created_at})=>({id,username,permissions,active,created_at})) as T[]};
          if(normalized.startsWith('SELECT ID,NAME,CREATED_AT,UPDATED_AT FROM ORGANIZATIONS ORDER BY NAME'))return{results:[...state.organizations].sort((a,b)=>a.name.localeCompare(b.name)).map(({id,name,created_at,updated_at})=>({id,name,created_at,updated_at})) as T[]};
          if(normalized.startsWith('SELECT ORGANIZATION_ID FROM USER_ORGANIZATIONS WHERE USER_ID='))return{results:state.userOrganizations.filter(item=>item.user_id===Number(values[0])).map(({organization_id})=>({organization_id})) as T[]};
          if(normalized.startsWith('SELECT USER_ID,ORGANIZATION_ID FROM USER_ORGANIZATIONS'))return{results:state.userOrganizations.map(({user_id,organization_id})=>({user_id,organization_id})) as T[]};
          if(normalized.startsWith('SELECT ORGANIZATIONS.ID, ORGANIZATIONS.NAME, ORGANIZATIONS.CREATED_AT, ORGANIZATIONS.UPDATED_AT FROM USER_ORGANIZATIONS JOIN ORGANIZATIONS')){
            const userId=Number(values[0]),ids=new Set(state.userOrganizations.filter(item=>item.user_id===userId).map(item=>item.organization_id));
            return{results:[...state.organizations].filter(item=>ids.has(item.id)).sort((a,b)=>a.name.localeCompare(b.name)).map(({id,name,created_at,updated_at})=>({id,name,created_at,updated_at})) as T[]};
          }
          if(normalized.startsWith('SELECT * FROM TEMPLATES WHERE ORGANIZATION_ID=')){
            const organizationId=String(values[0]);
            return{results:[...state.templates].filter(item=>(item.organization_id||defaultOrganizationId)===organizationId).sort((a,b)=>b.updated_at-a.updated_at) as T[]};
          }
          if(normalized.startsWith('SELECT * FROM TEMPLATES ORDER BY UPDATED_AT DESC'))return{results:[...state.templates].sort((a,b)=>b.updated_at-a.updated_at) as T[]};
          return{results:[]};
        }
      };
    }
    return{prepare:statement,batch:async statements=>Promise.all(statements.map(item=>item.run()))};
  })();
  return localDbPromise;
}

async function ignoreMigrationError(task:Promise<unknown>){
  try{await task;}catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(!/duplicate column|already exists/i.test(message))throw error;
  }
}

function toOrganization(row:{id:string;name:string;created_at:number;updated_at:number}):Organization{
  return{id:row.id,name:row.name,createdAt:row.created_at,updatedAt:row.updated_at};
}

async function migrateTemplateUniqueConstraint(db:AuthDb){
  const row=await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='templates'").first<{sql:string}>();
  const sql=row?.sql??'';
  if(!/normalized_name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sql)||/UNIQUE\s*\(\s*organization_id\s*,\s*normalized_name\s*\)/i.test(sql))return;
  const hasOrganizationId=/\borganization_id\b/i.test(sql),organizationExpression=hasOrganizationId?"COALESCE(NULLIF(organization_id,''),?)":"?";
  await db.prepare(`CREATE TABLE IF NOT EXISTS templates_next (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}', normalized_name TEXT NOT NULL, name TEXT NOT NULL, file_name TEXT NOT NULL, object_key TEXT NOT NULL, foreground_file_name TEXT, foreground_object_key TEXT, regions TEXT, has_cover INTEGER, page_count INTEGER, page_mode TEXT, duplex INTEGER, rotate_cover INTEGER, rotate_inner INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(organization_id, normalized_name))`).run();
  await db.prepare(`INSERT OR IGNORE INTO templates_next(id,organization_id,normalized_name,name,file_name,object_key,foreground_file_name,foreground_object_key,regions,has_cover,page_count,page_mode,duplex,rotate_cover,rotate_inner,created_at,updated_at) SELECT id,${organizationExpression},normalized_name,name,file_name,object_key,foreground_file_name,foreground_object_key,regions,has_cover,page_count,page_mode,duplex,rotate_cover,rotate_inner,created_at,updated_at FROM templates`).bind(defaultOrganizationId).run();
  await db.prepare('DROP TABLE templates').run();
  await db.prepare('ALTER TABLE templates_next RENAME TO templates').run();
}

export async function initializeAuth(){const db=await database();await db.batch([
  db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, salt TEXT NOT NULL, permissions TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)'),
  db.prepare('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)'),
  db.prepare('CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)'),
  db.prepare('CREATE TABLE IF NOT EXISTS user_organizations (user_id INTEGER NOT NULL, organization_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, organization_id), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(organization_id) REFERENCES organizations(id) ON DELETE CASCADE)'),
  db.prepare(`CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}', normalized_name TEXT NOT NULL, name TEXT NOT NULL, file_name TEXT NOT NULL, object_key TEXT NOT NULL, foreground_file_name TEXT, foreground_object_key TEXT, regions TEXT, has_cover INTEGER, page_count INTEGER, page_mode TEXT, duplex INTEGER, rotate_cover INTEGER, rotate_inner INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(organization_id, normalized_name))`),
  db.prepare('CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)'),
  db.prepare('CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)'),
  db.prepare('CREATE INDEX IF NOT EXISTS templates_updated_idx ON templates(updated_at)')
]);
const now=Date.now();
await migrateTemplateUniqueConstraint(db);
await ignoreMigrationError(db.prepare(`ALTER TABLE templates ADD COLUMN organization_id TEXT DEFAULT '${defaultOrganizationId}'`).run());
await db.prepare('INSERT OR IGNORE INTO organizations(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(defaultOrganizationId,defaultOrganizationName,now,now).run();
await db.prepare('UPDATE templates SET organization_id=? WHERE organization_id IS NULL OR organization_id=""').bind(defaultOrganizationId).run();
await db.prepare('INSERT OR IGNORE INTO user_organizations(user_id,organization_id,created_at) SELECT id,?,? FROM users').bind(defaultOrganizationId,now).run();
await db.prepare('CREATE INDEX IF NOT EXISTS templates_organization_updated_idx ON templates(organization_id, updated_at)').run();
return db;}

export async function hashPassword(password:string,saltHex?:string){const salt=saltHex?Uint8Array.from(saltHex.match(/.{2}/g)??[],part=>parseInt(part,16)):crypto.getRandomValues(new Uint8Array(16)),key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']),bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:210000},key,256);return{hash:hex(bits),salt:hex(salt)};}
export function cleanPermissions(value:unknown):Permission[]{const list=Array.isArray(value)?value:[];return allowedPermissions.filter(permission=>list.includes(permission));}
export function validCredentials(username:unknown,password:unknown){const name=String(username??'').trim(),secret=String(password??'');if(name.length<3||name.length>40)throw new Error('用户名需要3到40个字符');if(secret.length<10||secret.length>128)throw new Error('密码至少需要10个字符');return{name,secret};}
export function parseCookies(request:Request){return Object.fromEntries((request.headers.get('cookie')??'').split(';').map(item=>item.trim().split('=').map(decodeURIComponent)).filter(item=>item.length===2));}
export async function listOrganizations(){const db=await initializeAuth(),rows=await db.prepare('SELECT id,name,created_at,updated_at FROM organizations ORDER BY name').all<{id:string;name:string;created_at:number;updated_at:number}>();return rows.results.map(toOrganization);}
export async function listUserOrganizations(userId:number){const db=await initializeAuth(),rows=await db.prepare('SELECT organizations.id, organizations.name, organizations.created_at, organizations.updated_at FROM user_organizations JOIN organizations ON organizations.id=user_organizations.organization_id WHERE user_organizations.user_id=? ORDER BY organizations.name').bind(userId).all<{id:string;name:string;created_at:number;updated_at:number}>();return rows.results.map(toOrganization);}
export async function replaceUserOrganizations(userId:number,organizationIds:string[]){const clean=[...new Set(organizationIds.map(id=>String(id).trim()).filter(Boolean))];if(!clean.length)throw new Error('账号至少需要属于一个组织');const db=await initializeAuth();for(const id of clean){const row=await db.prepare('SELECT id FROM organizations WHERE id=?').bind(id).first<{id:string}>();if(!row)throw new Error('选择的组织不存在');}await db.prepare('DELETE FROM user_organizations WHERE user_id=?').bind(userId).run();const now=Date.now();await Promise.all(clean.map(id=>db.prepare('INSERT OR IGNORE INTO user_organizations(user_id,organization_id,created_at) VALUES(?,?,?)').bind(userId,id,now).run()));}
export async function createOrganization(nameValue:unknown){const name=String(nameValue??'').trim();if(name.length<2||name.length>40)throw new Error('组织名称需要2到40个字符');const db=await initializeAuth();if(await db.prepare('SELECT id FROM organizations WHERE name=?').bind(name).first())throw new Error('组织名称已存在');const now=Date.now(),id=`org_${now.toString(36)}_${crypto.randomUUID().slice(0,8)}`;await db.prepare('INSERT INTO organizations(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(id,name,now,now).run();return{id,name,createdAt:now,updatedAt:now};}
export async function updateOrganization(idValue:unknown,nameValue:unknown){const id=String(idValue??'').trim(),name=String(nameValue??'').trim();if(!id)throw new Error('组织不存在');if(name.length<2||name.length>40)throw new Error('组织名称需要2到40个字符');const db=await initializeAuth();if(await db.prepare('SELECT id FROM organizations WHERE name=? AND id<>?').bind(name,id).first())throw new Error('组织名称已存在');await db.prepare('UPDATE organizations SET name=?, updated_at=? WHERE id=?').bind(name,Date.now(),id).run();}
export async function deleteOrganization(idValue:unknown){const id=String(idValue??'').trim();if(id===defaultOrganizationId)throw new Error('默认组织不能删除');const db=await initializeAuth(),users=await db.prepare('SELECT COUNT(*) AS count FROM user_organizations WHERE organization_id=?').bind(id).first<{count:number}>(),templates=await db.prepare('SELECT COUNT(*) AS count FROM templates WHERE organization_id=?').bind(id).first<{count:number}>();if(Number(users?.count??0)>0)throw new Error('该组织仍有关联账号，不能删除');if(Number(templates?.count??0)>0)throw new Error('该组织仍有关联模板，不能删除');await db.prepare('DELETE FROM organizations WHERE id=?').bind(id).run();}
export function resolveOrganizationId(user:SessionUser,requested?:string|null){const fallback=user.organizationIds[0]??defaultOrganizationId;if(!requested)return fallback;if(!user.organizationIds.includes(requested))throw new Error('没有此组织权限');return requested;}
export function canAccessOrganization(user:SessionUser,organizationId:string){return user.organizationIds.includes(organizationId);}
export async function getSessionUser(request:Request):Promise<SessionUser|null>{const token=parseCookies(request).jht_session;if(!token)return null;const db=await initializeAuth(),now=Math.floor(Date.now()/1000),row=await db.prepare('SELECT users.id, users.username, users.permissions FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>? AND users.active=1').bind(await sha256(token),now).first<{id:number;username:string;permissions:string}>();if(!row)return null;const organizations=await listUserOrganizations(row.id);return{id:row.id,username:row.username,permissions:cleanPermissions(JSON.parse(row.permissions)),organizations,organizationIds:organizations.map(item=>item.id)};}
export async function requirePermission(request:Request,permission:Permission){const user=await getSessionUser(request);if(!user)return{error:Response.json({error:'请先登录'},{status:401})};if(!user.permissions.includes(permission))return{error:Response.json({error:'没有此项权限'},{status:403})};return{user};}
export async function createSession(userId:number){const db=await initializeAuth(),token=randomToken(),now=Math.floor(Date.now()/1000),expires=now+60*60*12;await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256(token),userId,expires,now).run();return{token,expires};}
export async function deleteSession(request:Request){const token=parseCookies(request).jht_session;if(token){const db=await initializeAuth();await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();}}
export function sessionCookie(token:string,maxAge=60*60*12){const secure=process.env.AUTH_COOKIE_SECURE==='true';return`jht_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;}
