import { createTemplate, listTemplates, publicTemplate, requireTemplatePermission, templateStorageProvider, templateStorageUnavailableHint } from './_store';

export async function GET(request:Request){
  const auth=await requireTemplatePermission(request);
  if('error'in auth)return auth.error;
  const templates=await listTemplates();
  return Response.json({provider:templateStorageProvider(),user:auth.user,templates:templates.map(publicTemplate)});
}

export async function POST(request:Request){
  const auth=await requireTemplatePermission(request);
  if('error'in auth)return auth.error;
  try{
    const form=await request.formData(),file=form.get('file'),foreground=form.get('foregroundFile'),metadataRaw=form.get('metadata');
    if(!(file instanceof File))throw new Error('请上传 PDF 模板文件');
    const metadata=metadataRaw?JSON.parse(String(metadataRaw)) as Record<string,unknown>:{};
    const template=await createTemplate({
      name:String(form.get('name')??file.name.replace(/\.pdf$/i,'')),
      file,
      foregroundFile:foreground instanceof File?foreground:undefined,
      metadata
    });
    return Response.json({template:publicTemplate(template)});
  }catch(error){
    return Response.json({error:error instanceof Error?error.message:'模板上传失败',provider:templateStorageProvider(),hint:templateStorageUnavailableHint()},{status:400});
  }
}
