import { cleanPermissions,hashPassword,initializeAuth,listOrganizations,replaceUserOrganizations,requirePermission,validCredentials } from '../_auth';

function cleanOrganizationIds(value:unknown){
  return Array.isArray(value)?value.map(item=>String(item).trim()).filter(Boolean):[];
}

export async function GET(request:Request){
  const auth=await requirePermission(request,'accounts');
  if('error'in auth)return auth.error;
  const db=await initializeAuth(),[result,organizations,links]=await Promise.all([
    db.prepare('SELECT id,username,permissions,active,created_at FROM users ORDER BY id').all<{id:number;username:string;permissions:string;active:number;created_at:number}>(),
    listOrganizations(),
    db.prepare('SELECT user_id,organization_id FROM user_organizations').all<{user_id:number;organization_id:string}>()
  ]);
  const byUser=new Map<number,string[]>();
  for(const link of links.results)byUser.set(link.user_id,[...(byUser.get(link.user_id)??[]),link.organization_id]);
  return Response.json({organizations,users:result.results.map(row=>({...row,active:Boolean(row.active),permissions:cleanPermissions(JSON.parse(row.permissions)),organizationIds:byUser.get(row.id)??[]}))});
}

export async function POST(request:Request){const auth=await requirePermission(request,'accounts');if('error'in auth)return auth.error;try{const body=await request.json() as Record<string,unknown>,{name,secret}=validCredentials(body.username,body.password),permissions=cleanPermissions(body.permissions),organizationIds=cleanOrganizationIds(body.organizationIds),password=await hashPassword(secret),db=await initializeAuth();const result=await db.prepare('INSERT INTO users(username,password_hash,salt,permissions,active,created_at) VALUES(?,?,?,?,1,?)').bind(name,password.hash,password.salt,JSON.stringify(permissions),Date.now()).run();await replaceUserOrganizations(Number(result.meta.last_row_id),organizationIds);return Response.json({ok:true});}catch(error){return Response.json({error:error instanceof Error?error.message:'创建账号失败'},{status:400});}}
export async function PATCH(request:Request){const auth=await requirePermission(request,'accounts');if('error'in auth)return auth.error;try{const body=await request.json() as Record<string,unknown>,id=Number(body.id),permissions=cleanPermissions(body.permissions),active=body.active!==false,organizationIds=cleanOrganizationIds(body.organizationIds),db=await initializeAuth();if(id===auth.user.id&&!active)throw new Error('不能停用当前登录账号');await db.prepare('UPDATE users SET permissions=?,active=? WHERE id=?').bind(JSON.stringify(permissions),active?1:0,id).run();await replaceUserOrganizations(id,organizationIds);if(body.password){const secret=String(body.password);if(secret.length<10)throw new Error('新密码至少需要10个字符');const password=await hashPassword(secret);await db.prepare('UPDATE users SET password_hash=?,salt=? WHERE id=?').bind(password.hash,password.salt,id).run();await db.prepare('DELETE FROM sessions WHERE user_id=? AND user_id<>?').bind(id,auth.user.id).run();}return Response.json({ok:true});}catch(error){return Response.json({error:error instanceof Error?error.message:'更新账号失败'},{status:400});}}
export async function DELETE(request:Request){const auth=await requirePermission(request,'accounts');if('error'in auth)return auth.error;try{const id=Number(new URL(request.url).searchParams.get('id')),db=await initializeAuth();if(id===auth.user.id)throw new Error('不能删除当前登录账号');await db.prepare('DELETE FROM users WHERE id=?').bind(id).run();return Response.json({ok:true});}catch(error){return Response.json({error:error instanceof Error?error.message:'删除账号失败'},{status:400});}}
