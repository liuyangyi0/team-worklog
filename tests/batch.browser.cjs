const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
(async()=>{
 const {createApp}=await import(pathToFileURL(path.resolve(__dirname,'../server.mjs')).href);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'worklog-batch-browser-'));const origin='http://127.0.0.1:8776',base=origin+'/worklog/api';let app,browser,p;
 try{
  app=await createApp({dataDir:dir,origin,dist:path.resolve(__dirname,'../dist')});await new Promise(r=>app.server.listen(8776,'127.0.0.1',r));
  async function api(route,method='GET',body,cookie=''){const r=await fetch(base+route,{method,headers:{Origin:origin,'Content-Type':'application/json','X-Worklog-Request':'1',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return{data,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const alice=await api('/register','POST',{name:'胡示例三',login:'batch_alice',password:'Temporary-test-123'});
  const project=(await api('/state')).data.projects[0],closed=(await api('/projects','POST',{name:'一期验收',color:'amber'},alice.cookie)).data;
  const create=(task,extra={})=>api('/records','POST',{project_id:project.id,task,owner:'胡示例三',...extra},alice.cookie).then(r=>r.data);
  const {beijingDate}=await import(pathToFileURL(path.resolve(__dirname,'../src/model.js')).href);const today=beijingDate();
  await create('整理接口文档',{description:'包含计费与网关两部分\n=SUM(A1) 不应被表格当作公式'});await create('部署测试环境');await create('编写验收报告');await create('保留不动的任务',{priority:'low'});
  await api('/records','POST',{project_id:closed.id,task:'已归档项目里的待办',owner:'胡示例三'},alice.cookie);
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto(origin+'/worklog/');await p.getByText('整理接口文档',{exact:true}).waitFor();
  assert.equal(await p.getByLabel('选择：整理接口文档',{exact:true}).count(),0,'guests cannot select rows');
  await p.getByRole('button',{name:'登录 / 注册',exact:false}).click();await p.getByLabel('账号',{exact:true}).fill('batch_alice');await p.getByLabel('密码',{exact:true}).fill('Temporary-test-123');await p.locator('form').getByRole('button',{name:'登录',exact:true}).click();
  await p.getByLabel('选择：整理接口文档',{exact:true}).waitFor();
  assert.equal(await p.getByRole('button',{name:/我的待办/}).textContent().then(t=>t.trim().endsWith('5')),true);
  // Description: shown in detail, searchable, editable.
  await p.getByRole('button',{name:'整理接口文档',exact:true}).click();const detail=p.getByRole('dialog',{name:'任务详情'});await detail.getByText('包含计费与网关两部分',{exact:false}).waitFor();await detail.getByRole('button',{name:'关闭',exact:true}).click();
  await p.getByLabel('搜索工作或姓名',{exact:true}).fill('网关');await p.getByRole('button',{name:'部署测试环境',exact:true}).waitFor({state:'hidden'});await p.getByRole('button',{name:'整理接口文档',exact:true}).waitFor();await p.getByLabel('清空搜索',{exact:true}).click();
  // Batch completion keeps untouched fields and records today's date.
  await p.getByLabel('每页显示条数',{exact:true}).selectOption('20');
  await p.getByLabel('选择：部署测试环境',{exact:true}).check();await p.getByLabel('选择：编写验收报告',{exact:true}).check();
  const bar=p.getByRole('toolbar',{name:'批量操作'});await bar.getByText('已选 2 项',{exact:true}).waitFor();
  await bar.getByRole('button',{name:'批量修改',exact:true}).click();const dlg=p.getByRole('dialog',{name:'批量修改'});
  assert.equal(await dlg.getByRole('button',{name:'应用到 2 项',exact:true}).isDisabled(),true,'nothing chosen yet');
  await dlg.getByRole('button',{name:'今天',exact:true}).click();await dlg.getByLabel('批量优先级',{exact:true}).selectOption('high');
  await dlg.getByRole('button',{name:'应用到 2 项',exact:true}).click();await p.getByText('已批量修改 2 项',{exact:true}).waitFor();
  let records=(await api('/state')).data.records;const byTask=t=>records.find(r=>r.task===t);
  for(const t of ['部署测试环境','编写验收报告']){assert.equal(byTask(t).date,today);assert.equal(byTask(t).priority,'high');}
  assert.equal(byTask('保留不动的任务').date,'');assert.equal(byTask('保留不动的任务').priority,'low');
  assert.equal(await bar.count(),0,'selection clears after saving');
  // Conflict: someone else edits a selected record first.
  await p.getByLabel('选择：保留不动的任务',{exact:true}).check();const keep=byTask('保留不动的任务');await api('/records/'+keep.id,'PATCH',{...keep,task:'被他人改过的任务'},alice.cookie);
  await bar.getByRole('button',{name:'批量修改',exact:true}).click();await dlg.getByLabel('批量优先级',{exact:true}).selectOption('urgent');await dlg.getByRole('button',{name:'应用到 1 项',exact:true}).click();
  await dlg.getByText('部分记录刚被他人修改或删除',{exact:false}).waitFor();await p.getByRole('button',{name:'被他人改过的任务',exact:true}).waitFor();
  await dlg.getByRole('button',{name:'应用到 1 项',exact:true}).click();await p.getByText('已批量修改 1 项',{exact:true}).waitFor();
  assert.equal((await api('/state')).data.records.find(r=>r.id===keep.id).priority,'urgent');
  // Batch delete with a single undo.
  await p.getByLabel('选择本页全部记录',{exact:true}).check();await bar.getByText('已选 4 项',{exact:true}).waitFor();
  await bar.getByRole('button',{name:'批量删除',exact:true}).click();await p.getByRole('dialog',{name:'删除所选 4 项？'}).getByRole('button',{name:'确认删除',exact:true}).click();
  await p.getByText('已删除 4 项',{exact:true}).waitFor();assert.equal((await api('/state')).data.records.filter(r=>r.project_id===project.id).length,0);
  await p.getByRole('button',{name:'撤销',exact:true}).click();await p.getByText('记录已恢复',{exact:true}).waitFor();assert.equal((await api('/state')).data.records.filter(r=>r.project_id===project.id).length,4);
  // CSV export.
  const csvDownload=p.waitForEvent('download');await p.getByRole('button',{name:'导出表格',exact:true}).click();const csvFile=path.join(dir,'export.csv');await(await csvDownload).saveAs(csvFile);
  const csv=await fs.readFile(csvFile,'utf8');assert.ok(csv.startsWith('﻿工作事项,上级任务,任务说明'));assert.ok(csv.includes('"包含计费与网关两部分\n=SUM(A1) 不应被表格当作公式"'),'multi-line descriptions stay in one quoted cell');assert.equal(csv.trim().split('\r\n').length,5);
  // Archive a finished project from its settings.
  await p.getByRole('button',{name:'一期验收',exact:true}).click();await p.getByRole('button',{name:'项目设置',exact:true}).click();await p.getByLabel('归档此项目',{exact:true}).check();await p.getByRole('button',{name:'保存设置',exact:true}).click();
  await p.getByRole('note').getByText('此项目已归档',{exact:false}).waitFor();assert.equal(await p.getByRole('navigation',{name:'已归档项目'}).getByRole('button',{name:'一期验收',exact:true}).count(),1);
  assert.equal(await p.getByRole('navigation',{name:'项目',exact:true}).getByRole('button',{name:'一期验收',exact:true}).count(),0);
  assert.equal(await p.getByRole('button',{name:/我的待办/}).textContent().then(t=>t.trim().endsWith('2')),true,'archived project leaves the to-do count');
  await p.getByRole('button',{name:'示例项目',exact:true}).click();await p.getByRole('button',{name:/已归档 · 1/}).waitFor();assert.equal(await p.getByRole('navigation',{name:'已归档项目'}).count(),0,'archived group starts collapsed');
  await p.getByRole('button',{name:/已归档 · 1/}).click();await p.getByRole('navigation',{name:'已归档项目'}).getByRole('button',{name:'一期验收',exact:true}).click();
  await p.getByRole('note').getByRole('button',{name:'取消归档',exact:true}).click();await p.getByText('项目已取消归档',{exact:true}).waitFor();assert.equal((await api('/state')).data.projects.find(x=>x.id===closed.id).archived,0);
  await p.getByRole('navigation',{name:'项目',exact:true}).getByRole('button',{name:'一期验收',exact:true}).waitFor();
  // Mobile layout stays within the viewport with a selection active.
  await p.getByRole('button',{name:'示例项目',exact:true}).click();await p.setViewportSize({width:390,height:844});await p.getByLabel('选择：整理接口文档',{exact:true}).check();await bar.waitFor();
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  assert.deepEqual(errors,[]);console.log('Batch browser passed: task descriptions and search, guarded selection, batch completion, conflict refresh, batch delete with undo, CSV export, project archive/restore and mobile layout.');
 }catch(e){if(p&&process.env.WORKLOG_QA_SCREENSHOT_DIR)await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'batch-failure.png')}).catch(()=>{});throw e;}
 finally{if(browser)await browser.close();if(app)await app.close();await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
