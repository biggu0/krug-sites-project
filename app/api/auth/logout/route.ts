import { deleteSession,sessionCookie } from '../../_auth';
export async function POST(request:Request){await deleteSession(request);return Response.json({ok:true},{headers:{'Set-Cookie':sessionCookie('',0)}});}
