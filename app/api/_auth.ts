import { env } from 'cloudflare:workers';

export type Permission='customization'|'templates'|'accounts';
export type SessionUser={id:number;username:string;permissions:Permission[]};
const allowedPermissions:Permission[]=['customization','templates','accounts'];
const encoder=new TextEncoder();

function database(){return (env as unknown as {DB:D1Database}).DB;}
function hex(bytes:ArrayBuffer|Uint8Array){return Array.from(new Uint8Array(bytes)).map(value=>value.toString(16).padStart(2,'0')).join('');}
function randomToken(bytes=32){const value=crypto.getRandomValues(new Uint8Array(bytes));return Array.from(value).map(item=>item.toString(16).padStart(2,'0')).join('');}
async function sha256(value:string){return hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));}

export async function initializeAuth(){const db=database();await db.batch([
  db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, salt TEXT NOT NULL, permissions TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)'),
  db.prepare('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)'),
  db.prepare('CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)'),
  db.prepare('CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)')
]);return db;}

export async function hashPassword(password:string,saltHex?:string){const salt=saltHex?Uint8Array.from(saltHex.match(/.{2}/g)??[],part=>parseInt(part,16)):crypto.getRandomValues(new Uint8Array(16)),key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']),bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:210000},key,256);return{hash:hex(bits),salt:hex(salt)};}
export function cleanPermissions(value:unknown):Permission[]{const list=Array.isArray(value)?value:[];return allowedPermissions.filter(permission=>list.includes(permission));}
export function validCredentials(username:unknown,password:unknown){const name=String(username??'').trim(),secret=String(password??'');if(name.length<3||name.length>40)throw new Error('用户名需要3到40个字符');if(secret.length<10||secret.length>128)throw new Error('密码至少需要10个字符');return{name,secret};}
export function parseCookies(request:Request){return Object.fromEntries((request.headers.get('cookie')??'').split(';').map(item=>item.trim().split('=').map(decodeURIComponent)).filter(item=>item.length===2));}
export async function getSessionUser(request:Request):Promise<SessionUser|null>{const token=parseCookies(request).jht_session;if(!token)return null;const db=await initializeAuth(),now=Math.floor(Date.now()/1000),row=await db.prepare('SELECT users.id, users.username, users.permissions FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>? AND users.active=1').bind(await sha256(token),now).first<{id:number;username:string;permissions:string}>();if(!row)return null;return{id:row.id,username:row.username,permissions:cleanPermissions(JSON.parse(row.permissions))};}
export async function requirePermission(request:Request,permission:Permission){const user=await getSessionUser(request);if(!user)return{error:Response.json({error:'请先登录'},{status:401})};if(!user.permissions.includes(permission))return{error:Response.json({error:'没有此项权限'},{status:403})};return{user};}
export async function createSession(userId:number){const db=await initializeAuth(),token=randomToken(),now=Math.floor(Date.now()/1000),expires=now+60*60*12;await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256(token),userId,expires,now).run();return{token,expires};}
export async function deleteSession(request:Request){const token=parseCookies(request).jht_session;if(token){const db=await initializeAuth();await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();}}
export function sessionCookie(token:string,maxAge=60*60*12){return`jht_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`;}
