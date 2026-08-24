import { getSessionUser,initializeAuth } from '../../_auth';
export async function GET(request:Request){const db=await initializeAuth(),count=await db.prepare('SELECT COUNT(*) AS count FROM users').first<{count:number}>(),user=await getSessionUser(request);return Response.json({setupRequired:Number(count?.count??0)===0,user});}
