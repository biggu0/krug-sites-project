import { publicTemplate, readTemplateFile, requireTemplatePermission, updateTemplateForeground } from '../../_store';

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireTemplatePermission(request);
  if('error'in auth)return auth.error;
  try{
    const {id}=await params;
    const bytes=await readTemplateFile(id,'foreground');
    return new Response(bytes,{headers:{'Content-Type':'application/pdf','Cache-Control':'no-store'}});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'前景保护层读取失败'},{status:404});
  }
}

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
  const auth=await requireTemplatePermission(request);
  if('error'in auth)return auth.error;
  try{
    const {id}=await params,form=await request.formData(),file=form.get('file');
    if(!(file instanceof File))throw new Error('请上传前景保护 PDF');
    const template=await updateTemplateForeground(id,file);
    return Response.json({template:publicTemplate(template)});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'前景保护层上传失败'},{status:400});
  }
}
