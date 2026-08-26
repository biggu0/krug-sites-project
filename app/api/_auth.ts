export type Permission='customization'|'templates'|'accounts';
export type SessionUser={id:number;username:string;permissions:Permission[]};

type UserRow={id:number;username:string;password_hash:string;salt:string;permissions:string;active:number;created_at:number};
type SessionRow={token_hash:string;user_id:number;expires_at:number;created_at:number};
type TemplateRow={id:string;normalized_name:string;name:string;file_name:string;object_key:string;foreground_file_name?:string|null;foreground_object_key?:string|null;regions?:string|null;has_cover?:number|null;page_count?:number|null;page_mode?:string|null;duplex?:number|null;rotate_cover?:number|null;rotate_inner?:number|null;created_at:number;updated_at:number};
type LocalState={nextUserId:number;users:UserRow[];sessions:SessionRow[];templates:TemplateRow[]};
type QueryResult<T=unknown>={results:T[]};
type AuthStatement={bind:(...values:unknown[])=>AuthStatement;run:()=>Promise<{meta:{last_row_id?:number}}>;first:<T=unknown>()=>Promise<T|undefined>;all:<T=unknown>()=>Promise<QueryResult<T>>};
type AuthDb={prepare:(sql:string)=>AuthStatement;batch:(statements:AuthStatement[])=>Promise<unknown[]>};

const allowedPermissions:Permission[]=['customization','templates','accounts'];
const encoder=new TextEncoder();
let localDbPromise:Promise<AuthDb>|undefined;

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
    async function read():Promise<LocalState>{try{const state=JSON.parse(await fs.readFile(filePath,'utf8')) as Partial<LocalState>;return{nextUserId:state.nextUserId??1,users:state.users??[],sessions:state.sessions??[],templates:state.templates??[]};}catch{return{nextUserId:1,users:[],sessions:[],templates:[]};}}
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
            dirty=true;
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
            const row:TemplateRow={id:String(values[0]),normalized_name:String(values[1]),name:String(values[2]),file_name:String(values[3]),object_key:String(values[4]),foreground_file_name:values[5]===undefined?null:String(values[5]),foreground_object_key:values[6]===undefined?null:String(values[6]),regions:values[7]===undefined?null:String(values[7]),has_cover:values[8]===undefined||values[8]===null?null:Number(values[8]),page_count:values[9]===undefined||values[9]===null?null:Number(values[9]),page_mode:values[10]===undefined||values[10]===null?null:String(values[10]),duplex:values[11]===undefined||values[11]===null?null:Number(values[11]),rotate_cover:values[12]===undefined||values[12]===null?null:Number(values[12]),rotate_inner:values[13]===undefined||values[13]===null?null:Number(values[13]),created_at:Number(values[14]),updated_at:Number(values[15])};
            if(state.templates.some(template=>template.normalized_name===row.normalized_name))throw new Error('UNIQUE constraint failed: templates.normalized_name');
            state.templates.push(row);
            dirty=true;
          }else if(normalized.startsWith('UPDATE TEMPLATES SET NORMALIZED_NAME=')){
            const id=String(values[12]),template=state.templates.find(item=>item.id===id);
            if(template){
              const normalizedName=String(values[0]);
              if(state.templates.some(item=>item.id!==id&&item.normalized_name===normalizedName))throw new Error('UNIQUE constraint failed: templates.normalized_name');
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
          if(normalized.startsWith('SELECT ID FROM TEMPLATES WHERE NORMALIZED_NAME=')){
            const name=String(values[0]),exclude=values[1]===undefined?undefined:String(values[1]);
            return state.templates.find(item=>item.normalized_name===name&&item.id!==exclude) as T|undefined;
          }
          return undefined;
        },
        async all<T=unknown>(){
          const state=await read();
          if(normalized.startsWith('SELECT ID,USERNAME,PERMISSIONS,ACTIVE,CREATED_AT FROM USERS ORDER BY ID'))return{results:[...state.users].sort((a,b)=>a.id-b.id).map(({id,username,permissions,active,created_at})=>({id,username,permissions,active,created_at})) as T[]};
          if(normalized.startsWith('SELECT * FROM TEMPLATES ORDER BY UPDATED_AT DESC'))return{results:[...state.templates].sort((a,b)=>b.updated_at-a.updated_at) as T[]};
          return{results:[]};
        }
      };
    }
    return{prepare:statement,batch:async statements=>Promise.all(statements.map(item=>item.run()))};
  })();
  return localDbPromise;
}

export async function initializeAuth(){const db=await database();await db.batch([
  db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, salt TEXT NOT NULL, permissions TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)'),
  db.prepare('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)'),
  db.prepare('CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, normalized_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL, file_name TEXT NOT NULL, object_key TEXT NOT NULL, foreground_file_name TEXT, foreground_object_key TEXT, regions TEXT, has_cover INTEGER, page_count INTEGER, page_mode TEXT, duplex INTEGER, rotate_cover INTEGER, rotate_inner INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)'),
  db.prepare('CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)'),
  db.prepare('CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)'),
  db.prepare('CREATE INDEX IF NOT EXISTS templates_updated_idx ON templates(updated_at)')
]);return db;}

export async function hashPassword(password:string,saltHex?:string){const salt=saltHex?Uint8Array.from(saltHex.match(/.{2}/g)??[],part=>parseInt(part,16)):crypto.getRandomValues(new Uint8Array(16)),key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']),bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:210000},key,256);return{hash:hex(bits),salt:hex(salt)};}
export function cleanPermissions(value:unknown):Permission[]{const list=Array.isArray(value)?value:[];return allowedPermissions.filter(permission=>list.includes(permission));}
export function validCredentials(username:unknown,password:unknown){const name=String(username??'').trim(),secret=String(password??'');if(name.length<3||name.length>40)throw new Error('用户名需要3到40个字符');if(secret.length<10||secret.length>128)throw new Error('密码至少需要10个字符');return{name,secret};}
export function parseCookies(request:Request){return Object.fromEntries((request.headers.get('cookie')??'').split(';').map(item=>item.trim().split('=').map(decodeURIComponent)).filter(item=>item.length===2));}
export async function getSessionUser(request:Request):Promise<SessionUser|null>{const token=parseCookies(request).jht_session;if(!token)return null;const db=await initializeAuth(),now=Math.floor(Date.now()/1000),row=await db.prepare('SELECT users.id, users.username, users.permissions FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>? AND users.active=1').bind(await sha256(token),now).first<{id:number;username:string;permissions:string}>();if(!row)return null;return{id:row.id,username:row.username,permissions:cleanPermissions(JSON.parse(row.permissions))};}
export async function requirePermission(request:Request,permission:Permission){const user=await getSessionUser(request);if(!user)return{error:Response.json({error:'请先登录'},{status:401})};if(!user.permissions.includes(permission))return{error:Response.json({error:'没有此项权限'},{status:403})};return{user};}
export async function createSession(userId:number){const db=await initializeAuth(),token=randomToken(),now=Math.floor(Date.now()/1000),expires=now+60*60*12;await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256(token),userId,expires,now).run();return{token,expires};}
export async function deleteSession(request:Request){const token=parseCookies(request).jht_session;if(token){const db=await initializeAuth();await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();}}
export function sessionCookie(token:string,maxAge=60*60*12){const secure=process.env.AUTH_COOKIE_SECURE==='true';return`jht_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;}
