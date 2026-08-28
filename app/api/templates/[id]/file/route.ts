import { readTemplateFile, requireTemplatePermission } from '../../_store';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireTemplatePermission(request);
  if('error'in auth)return auth.error;
  try{
    const {id}=await params;
    const bytes=await readTemplateFile(id,'file');
    return new Response(bytes,{headers:{'Content-Type':'application/pdf','Content-Length':String(bytes.byteLength),'Cache-Control':'no-store'}});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'模板文件读取失败'},{status:404});
  }
}
