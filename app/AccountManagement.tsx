'use client';
import {FormEvent,useEffect,useState} from 'react';
import {Organization,Permission,useAuth} from './AuthGate';

type Account={id:number;username:string;permissions:Permission[];active:boolean;created_at:number;organizationIds:string[]};
type AccountsPayload={users:Account[];organizations:Organization[];error?:string};

const permissionLabels:Record<Permission,string>={customization:'定制处理',templates:'模板管理',accounts:'账号管理'};
const permissions=Object.keys(permissionLabels) as Permission[];

function checkedValues(form:FormData,name:string){
  return form.getAll(name).map(value=>String(value)).filter(Boolean);
}

export default function AccountManagement(){
  const {user}=useAuth();
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [organizations,setOrganizations]=useState<Organization[]>([]);
  const [message,setMessage]=useState('');
  const [busy,setBusy]=useState(false);

  const load=async()=>{
    const response=await fetch('/api/accounts',{cache:'no-store'});
    const data=await response.json() as AccountsPayload;
    if(!response.ok)throw new Error(data.error??'账号列表加载失败');
    setAccounts(data.users);
    setOrganizations(data.organizations);
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{load().catch(error=>setMessage(error.message));},[]);

  const create=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    const form=event.currentTarget,data=new FormData(form);
    setBusy(true);
    setMessage('');
    try{
      const response=await fetch('/api/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        username:data.get('username'),
        password:data.get('password'),
        permissions:permissions.filter(item=>data.get(item)==='on'),
        organizationIds:checkedValues(data,'organizationIds')
      })});
      const result=await response.json() as {error?:string};
      if(!response.ok)throw new Error(result.error??'创建账号失败');
      form.reset();
      setMessage('账号创建成功');
      await load();
    }catch(error){
      setMessage(error instanceof Error?error.message:'创建账号失败');
    }finally{
      setBusy(false);
    }
  };

  const createOrganization=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    const form=event.currentTarget,data=new FormData(form);
    setBusy(true);
    setMessage('');
    try{
      const response=await fetch('/api/organizations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:data.get('name')})});
      const result=await response.json() as {error?:string};
      if(!response.ok)throw new Error(result.error??'创建组织失败');
      form.reset();
      setMessage('组织创建成功');
      await load();
    }catch(error){
      setMessage(error instanceof Error?error.message:'创建组织失败');
    }finally{
      setBusy(false);
    }
  };

  const update=async(account:Account,patch:Partial<Account>)=>{
    const next={...account,...patch};
    const response=await fetch('/api/accounts',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      id:next.id,
      permissions:next.permissions,
      active:next.active,
      organizationIds:next.organizationIds
    })});
    const result=await response.json() as {error?:string};
    if(!response.ok){
      setMessage(result.error??'更新账号失败');
      return;
    }
    if(account.id===user.id&&patch.organizationIds){
      window.location.reload();
      return;
    }
    setMessage('账号设置已经保存');
    await load();
  };

  const updateOrganization=async(organization:Organization)=>{
    const name=window.prompt('请输入组织名称',organization.name)?.trim();
    if(!name||name===organization.name)return;
    const response=await fetch('/api/organizations',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:organization.id,name})});
    const result=await response.json() as {error?:string};
    if(!response.ok){
      setMessage(result.error??'更新组织失败');
      return;
    }
    setMessage('组织已经更新');
    await load();
  };

  const remove=async(account:Account)=>{
    if(!confirm(`确定删除账号“${account.username}”吗？`))return;
    const response=await fetch(`/api/accounts?id=${account.id}`,{method:'DELETE'});
    const result=await response.json() as {error?:string};
    if(!response.ok){
      setMessage(result.error??'删除账号失败');
      return;
    }
    setMessage('账号已经删除');
    await load();
  };

  const removeOrganization=async(organization:Organization)=>{
    if(!confirm(`确定删除组织“${organization.name}”吗？关联账号和模板需要先移走。`))return;
    const response=await fetch(`/api/organizations?id=${encodeURIComponent(organization.id)}`,{method:'DELETE'});
    const result=await response.json() as {error?:string};
    if(!response.ok){
      setMessage(result.error??'删除组织失败');
      return;
    }
    setMessage('组织已经删除');
    await load();
  };

  const toggleOrganization=(account:Account,organizationId:string,checked:boolean)=>{
    const current=new Set(account.organizationIds);
    if(checked)current.add(organizationId);
    else current.delete(organizationId);
    update(account,{organizationIds:[...current]});
  };

  return <main className="account-page with-sidebar">
    <header className="system-bar page-topbar"><div className="page-heading"><b>账号、组织与权限</b><span>组织决定模板可见范围</span></div></header>
    <div className="account-content">
      <section className="account-create">
        <h2>创建账号</h2>
        <form onSubmit={create}>
          <label>用户名<input name="username" minLength={3} maxLength={40} required/></label>
          <label>初始密码<input name="password" type="password" minLength={10} maxLength={128} required/></label>
          <fieldset><legend>菜单权限</legend>{permissions.map(key=><label key={key}><input type="checkbox" name={key} defaultChecked={key!=='accounts'}/>{permissionLabels[key]}</label>)}</fieldset>
          <fieldset><legend>所属组织</legend>{organizations.map(item=><label key={item.id}><input type="checkbox" name="organizationIds" value={item.id} defaultChecked={item.id===user.organizationIds[0]}/>{item.name}</label>)}</fieldset>
          <button disabled={busy}>{busy?'创建中…':'创建账号'}</button>
        </form>
        <form className="organization-create" onSubmit={createOrganization}>
          <h2>创建组织</h2>
          <label>组织名称<input name="name" minLength={2} maxLength={40} required/></label>
          <button disabled={busy}>{busy?'处理中…':'创建组织'}</button>
        </form>
      </section>
      <section className="account-list">
        <div className="account-title"><h2>现有账号</h2><span>{accounts.length}</span></div>
        {accounts.map(account=><article key={account.id}>
          <div><b>{account.username}</b><small>{account.id===user.id?'当前账号':'账号'} · {account.active?'已启用':'已停用'}</small></div>
          <div className="permission-switches">{permissions.map(key=><label key={key}><input type="checkbox" checked={account.permissions.includes(key)} onChange={event=>update(account,{permissions:event.target.checked?[...account.permissions,key]:account.permissions.filter(item=>item!==key)})}/>{permissionLabels[key]}</label>)}</div>
          <div className="organization-switches">{organizations.map(item=><label key={item.id}><input type="checkbox" checked={account.organizationIds.includes(item.id)} onChange={event=>toggleOrganization(account,item.id,event.target.checked)}/>{item.name}</label>)}</div>
          <button className={account.active?'disable':'enable'} disabled={account.id===user.id} onClick={()=>update(account,{active:!account.active})}>{account.active?'停用':'启用'}</button>
          <button className="delete" disabled={account.id===user.id} onClick={()=>remove(account)}>删除</button>
        </article>)}
        <div className="organization-list">
          <h2>组织列表</h2>
          {organizations.map(item=><div key={item.id}><b>{item.name}</b><span>{item.id}</span><button onClick={()=>updateOrganization(item)}>修改</button><button className="delete" disabled={item.id==='org_default'} onClick={()=>removeOrganization(item)}>删除</button></div>)}
        </div>
        <p>{message}</p>
      </section>
    </div>
  </main>;
}
