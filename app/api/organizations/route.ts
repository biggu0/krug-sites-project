import { createOrganization,deleteOrganization,listOrganizations,requirePermission,updateOrganization } from '../_auth';

export async function GET(request:Request){
  const auth=await requirePermission(request,'accounts');
  if('error'in auth)return auth.error;
  return Response.json({organizations:await listOrganizations()});
}

export async function POST(request:Request){
  const auth=await requirePermission(request,'accounts');
  if('error'in auth)return auth.error;
  try{
    const body=await request.json() as Record<string,unknown>;
    return Response.json({organization:await createOrganization(body.name)});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'创建组织失败'},{status:400});
  }
}

export async function PATCH(request:Request){
  const auth=await requirePermission(request,'accounts');
  if('error'in auth)return auth.error;
  try{
    const body=await request.json() as Record<string,unknown>;
    await updateOrganization(body.id,body.name);
    return Response.json({ok:true});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'更新组织失败'},{status:400});
  }
}

export async function DELETE(request:Request){
  const auth=await requirePermission(request,'accounts');
  if('error'in auth)return auth.error;
  try{
    await deleteOrganization(new URL(request.url).searchParams.get('id'));
    return Response.json({ok:true});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'删除组织失败'},{status:400});
  }
}
