const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
(async()=>{
 const {createApp}=await import(pathToFileURL(path.resolve(__dirname,'../server.mjs')).href);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'worklog-planning-browser-'));const origin='http://127.0.0.1:8772',base=origin+'/worklog/api';let app,browser,p;
 try{
  app=await createApp({dataDir:dir,origin,dist:path.resolve(__dirname,'../dist')});await new Promise(r=>app.server.listen(8772,'127.0.0.1',r));
  async function api(route,method='GET',body,cookie=''){const r=await fetch(base+route,{method,headers:{Origin:origin,'Content-Type':'application/json','X-Worklog-Request':'1',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return{data,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const alice=await api('/register','POST',{name:'胡示例三',login:'planning_alice',password:'Temporary-test-123'}),bob=await api('/register','POST',{name:'韩示例二',login:'planning_bob',password:'Temporary-test-123'});
  const state=(await api('/state')).data;const a=state.projects[0],b=(await api('/projects','POST',{name:'运维平台',color:'emerald'},alice.cookie)).data;
  async function create(task,extra={}){return(await api('/records','POST',{project_id:a.id,task,owner:'韩示例二',actual:'',date:'',priority:'normal',due_date:'',...extra},alice.cookie)).data;}
  const {beijingDate}=await import(pathToFileURL(path.resolve(__dirname,'../src/model.js')).href);const today=beijingDate();const yesterday=new Date(today+'T00:00:00Z');yesterday.setUTCDate(yesterday.getUTCDate()-1);
  const overdue=await create('接口协议核对',{owner:'胡示例三、韩示例二',priority:'high',due_date:yesterday.toISOString().slice(0,10)});
  await create('现场设备联调',{priority:'urgent',due_date:today});
  await create('补充验收资料',{project_id:b.id});
  await create('下周环境准备',{due_date:'2099-12-31',priority:'low'});
  await create('已完成但未填日期',{actual:'胡示例三',due_date:yesterday.toISOString().slice(0,10)});
  await create('只填写完成日期',{date:today});await create('其他人的待办',{owner:'胡示例三'});
  await api('/records/'+overdue.id+'/comments','POST',{body:'请 @韩示例二 核对最后两项。'},alice.cookie);
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});const context=await browser.newContext({viewport:{width:1440,height:1050}});await context.addInitScript(()=>localStorage.setItem('worklog-list-preferences',JSON.stringify({pageSize:100,sort:'date-desc'})));p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
  async function shot(name){if(process.env.WORKLOG_QA_SCREENSHOT_DIR){await fs.mkdir(process.env.WORKLOG_QA_SCREENSHOT_DIR,{recursive:true});await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,name+'.png'),animations:'disabled'});}}
  async function refresh(){const done=p.waitForResponse(r=>r.url()===base+'/state');await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await done;}
  await p.goto(origin+'/worklog/');await p.getByRole('button',{name:'接口协议核对',exact:true}).waitFor();
  assert.deepEqual(await p.locator('.record-table th').allTextContents(),['工作事项','原定负责人','实际完成人','完成日期','操作']);
  assert.equal(await p.getByRole('button',{name:/站内提醒/}).count(),0);
  await p.getByLabel('优先级筛选',{exact:true}).selectOption('urgent');assert.equal(await p.locator('.record-table tbody tr').count(),1);
  await p.getByRole('button',{name:'重置筛选',exact:true}).click();await p.getByLabel('计划日期筛选',{exact:true}).selectOption('overdue');assert.equal(await p.locator('.record-table tbody tr').count(),1);
  await p.getByRole('button',{name:'重置筛选',exact:true}).click();
  await p.getByRole('button',{name:'我的待办',exact:true}).click();const auth=p.getByRole('dialog',{name:'欢迎来到项目工作台',exact:true});await auth.getByLabel('账号',{exact:true}).fill('planning_bob');await auth.getByLabel('密码',{exact:true}).fill('Temporary-test-123');await auth.locator('button[type=submit]').click();await auth.waitFor({state:'hidden'});
  await p.getByRole('heading',{name:'我的待办',exact:true}).waitFor();assert.equal(await p.locator('[data-todo-id]').count(),4);
  assert.deepEqual(await p.locator('[data-todo-id]').evaluateAll(rows=>rows.map(r=>r.innerText.split('\n')[0])),['接口协议核对','现场设备联调','下周环境准备','补充验收资料']);
  await p.getByRole('button',{name:/已逾期\s*1\s*项/}).click();assert.equal(await p.locator('[data-todo-id]').count(),1);await p.getByRole('button',{name:'重置待办筛选',exact:true}).click();
  await p.getByLabel('待办优先级筛选',{exact:true}).selectOption('urgent');assert.equal(await p.locator('[data-todo-id]').count(),1);await p.getByRole('button',{name:'重置待办筛选',exact:true}).click();
  await p.getByLabel('待办项目筛选',{exact:true}).selectOption(b.id);assert.equal(await p.locator('[data-todo-id]').count(),1);await p.getByRole('button',{name:'重置待办筛选',exact:true}).click();
  await shot('my-todos');
  await p.locator('[data-todo-id="'+overdue.id+'"]').click();const detail=()=>p.getByRole('dialog',{name:'任务详情',exact:true});await detail().getByText('请 @韩示例二 核对最后两项。',{exact:true}).waitFor();
  await detail().getByLabel('提及成员',{exact:true}).selectOption('胡示例三');assert.equal(await detail().getByLabel('评论内容',{exact:true}).inputValue(),'@胡示例三 ');await detail().getByLabel('评论内容',{exact:true}).fill('@胡示例三 已完成初步核对。');await detail().getByRole('button',{name:'发表评论',exact:true}).click();await detail().getByText('评论已发表',{exact:true}).waitFor();assert.equal((await api('/notifications','GET',undefined,alice.cookie)).data.entries[0].kind,'mentioned');
  await detail().getByRole('button',{name:'编辑任务',exact:true}).click();const edit=p.getByRole('dialog',{name:'编辑记录',exact:true});await edit.getByLabel('计划完成日期（选填）',{exact:true}).fill('2099-11-20');await edit.getByLabel('优先级',{exact:true}).selectOption('urgent');await shot('planning-form');await edit.getByRole('button',{name:'保存修改',exact:true}).click();await edit.waitFor({state:'hidden'});await detail().getByText('计划 2099-11-20',{exact:true}).waitFor();
  const saved=(await api('/state')).data.records.find(r=>r.id===overdue.id);assert.equal(saved.priority,'urgent');assert.equal(saved.due_date,'2099-11-20');assert.equal(saved.actual,'');assert.equal(saved.date,'');await detail().getByTitle('实际完成人和完成日期均未填写',{exact:true}).waitFor();await detail().getByRole('button',{name:'关闭',exact:true}).click();
  await p.getByRole('button',{name:/站内提醒/}).click();const inbox=()=>p.getByRole('dialog',{name:'站内提醒',exact:true});await inbox().locator('[data-notification-id]').first().waitFor();await shot('notifications');await inbox().getByRole('button',{name:'全部已读',exact:true}).click();await inbox().getByRole('button',{name:'全部已读',exact:true}).waitFor({state:'visible'});await inbox().getByRole('button',{name:/未读提醒/}).click();await inbox().getByText('暂时没有未读提醒',{exact:true}).waitFor();assert.equal((await api('/notifications','GET',undefined,bob.cookie)).data.unread,0);
  await inbox().getByRole('button',{name:'关闭',exact:true}).click();
  await api('/records/'+overdue.id+'/comments','POST',{body:'请 @韩示例二 再次确认。'},alice.cookie);await refresh();await p.getByRole('button',{name:/站内提醒/}).click();await inbox().getByText('请 @韩示例二 再次确认。',{exact:true}).waitFor();await inbox().locator('[data-notification-id]').first().click();await detail().getByRole('heading',{name:'接口协议核对',exact:true}).waitFor();await detail().getByRole('button',{name:'关闭',exact:true}).click();
  // Loading older pages must not mark a newly arrived, unseen reminder as read.
  for(let i=0;i<23;i++)await api('/records/'+overdue.id+'/comments','POST',{body:'@韩示例二 分页检查 '+i},alice.cookie);
  await refresh();await p.getByRole('button',{name:/站内提醒/}).click();await inbox().locator('[data-notification-id]').first().waitFor();assert.equal(await inbox().locator('[data-notification-id]').count(),20);
  await api('/records/'+overdue.id+'/comments','POST',{body:'@韩示例二 刚刚收到的新提醒'},alice.cookie);
  await inbox().getByRole('button',{name:'加载更早提醒',exact:true}).click();await inbox().locator('[data-notification-id]').nth(20).waitFor();
  await inbox().getByRole('button',{name:'全部已读',exact:true}).click();await inbox().getByText('@韩示例二 刚刚收到的新提醒',{exact:true}).waitFor();
  const stillUnread=(await api('/notifications?unread=1','GET',undefined,bob.cookie)).data;assert.equal(stillUnread.unread,1);assert.equal(stillUnread.entries[0].message,'@韩示例二 刚刚收到的新提醒');
  await inbox().getByRole('button',{name:'全部已读',exact:true}).click();await inbox().getByRole('button',{name:'全部已读',exact:true}).waitFor();await inbox().getByRole('button',{name:'关闭',exact:true}).click();
  await p.setViewportSize({width:390,height:844});await shot('my-todos-mobile');assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await p.getByRole('button',{name:/站内提醒/}).click();await inbox().getByRole('button',{name:'全部提醒',exact:true}).waitFor();assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);await inbox().getByRole('button',{name:'关闭',exact:true}).click();
  assert.deepEqual(errors,[]);console.log('Planning browser passed: date and priority editing, public filters, multi-owner cross-project todos, private mentions/read state, task navigation and mobile layout.');
 }catch(e){if(p&&process.env.WORKLOG_QA_SCREENSHOT_DIR)await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'planning-failure.png')}).catch(()=>{});throw e;}
 finally{if(browser)await browser.close();if(app)await app.close();await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
