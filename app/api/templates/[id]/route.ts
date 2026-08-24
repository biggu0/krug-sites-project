import { deleteTemplate, publicTemplate, requireTemplatePermission, updateTemplate } from '../_store';

export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireTemplatePermission(request);
  if('error'in auth)return auth.error;
  try{
    const {id}=await params;
    const template=await updateTemplate(id,await request.json() as Record<string,unknown>);
    return Response.json({template:publicTemplate(template)});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'模板更新失败'},{status:400});
  }
}

export async function DELETE(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireTemplatePermission(request);
  if('error'in auth)return auth.error;
  try{
    const {id}=await params;
    await deleteTemplate(id);
    return Response.json({ok:true});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'模板删除失败'},{status:400});
  }
}
