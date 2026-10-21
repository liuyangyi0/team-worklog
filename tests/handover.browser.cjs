const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
(async()=>{
 const {createApp}=await import(pathToFileURL(path.resolve(__dirname,'../server.mjs')).href);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'worklog-handover-browser-'));const origin='http://127.0.0.1:8777',base=origin+'/worklog/api';let app,browser,p;
 try{
  app=await createApp({dataDir:dir,origin,dist:path.resolve(__dirname,'../dist')});await new Promise(r=>app.server.listen(8777,'127.0.0.1',r));
  async function api(route,method='GET',body,cookie=''){const r=await fetch(base+route,{method,headers:{Origin:origin,'Content-Type':'application/json','X-Worklog-Request':'1',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return{data,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const alice=await api('/register','POST',{name:'胡示例三',login:'handover_alice',password:'Temporary-test-123'});
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
  const [name,value]=alice.cookie.split(/=(.*)/);await context.addCookies([{name,value,url:origin}]);
  await p.goto(origin+'/worklog/');await p.getByRole('button',{name:'新建项目',exact:true}).waitFor();
  // A new project gets a starter checklist for its kind.
  await p.getByRole('button',{name:'新建项目',exact:true}).click();await p.getByLabel('项目名称',{exact:true}).fill('三号园区改造');await p.getByLabel('资料清单',{exact:true}).selectOption('equipment');
  await p.getByRole('button',{name:'创建项目',exact:true}).click();await p.getByText('已生成',{exact:false}).waitFor();
  const project=(await api('/state')).data.projects.find(x=>x.name==='三号园区改造');
  const items=()=>api('/projects/'+project.id+'/deliverables','GET',undefined,alice.cookie).then(r=>r.data.items);
  let list=await items();assert.ok(list.some(i=>i.title==='设备清单'&&i.required));assert.ok(!list.some(i=>i.title==='部署手册'),'equipment projects skip software-only items');
  const docsTab=p.getByRole('navigation',{name:'项目模块'}).getByRole('button',{name:/项目资料/});
  const missing=list.filter(i=>i.required).length;assert.equal((await docsTab.innerText()).replace(/\s+/g,''),'项目资料缺'+missing);
  await docsTab.click();const checklist=p.getByRole('region',{name:'交接资料清单'});await checklist.getByText('必需资料已提供',{exact:false}).waitFor();
  const row=(title)=>checklist.getByRole('row').filter({has:p.getByText(title,{exact:true})});
  await row('方案设计 / 网络规划').getByText('未提供',{exact:true}).waitFor();await row('设备清单').getByText('缺少资料',{exact:true}).waitFor();
  // The checklist sits above the library; uploads go into a stage folder and link the item.
  assert.ok(await p.evaluate(()=>Boolean(document.querySelector('[aria-label="交接资料清单"]').compareDocumentPosition(document.querySelector('[aria-label="搜索资料"]'))&Node.DOCUMENT_POSITION_FOLLOWING)),'checklist comes before the library');
  await checklist.getByLabel('上传到：设备清单',{exact:true}).setInputFiles({name:'设备清单.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from('型号,序列号\nS5735,1234')});
  await checklist.getByText('已上传到“设备清单”',{exact:true}).waitFor();await row('设备清单').getByText('只有工作版',{exact:true}).waitFor();
  const docs=(await api('/projects/'+project.id+'/documents','GET',undefined,alice.cookie)).data;const sheet=docs.documents.find(d=>d.title==='设备清单.xlsx');
  assert.equal(docs.folders.find(f=>f.id===sheet.folder_id).name,'实施');assert.equal(sheet.category,'设备清单');
  await p.getByRole('button',{name:'编辑目录 实施',exact:true}).waitFor();
  // A second upload to the same item becomes its next version.
  await checklist.getByLabel('上传到：设备清单',{exact:true}).setInputFiles({name:'设备清单-v2.xlsx',mimeType:'application/octet-stream',buffer:Buffer.from('型号,序列号\nS5735,5678')});
  await checklist.getByText('已上传到“设备清单”',{exact:true}).waitFor();
  assert.equal((await api('/documents/'+sheet.id,'GET',undefined,alice.cookie)).data.versions.length,2);
  // A site-log entry with a photo satisfies "现场配置记录".
  await row('现场配置记录').getByRole('button',{name:'随手记：现场配置记录',exact:true}).click();
  let dialog=p.getByRole('dialog',{name:'记一条随手记'});await dialog.getByLabel('内容',{exact:true}).fill('3 号柜交换机 IP 改为 192.168.1.20（原 .10）');
  assert.equal(await dialog.getByLabel('关联资料项（选填）',{exact:true}).inputValue(),list.find(i=>i.title==='现场配置记录').id);
  await dialog.getByLabel('发生日期',{exact:true}).fill('2026-10-19');
  await dialog.getByLabel('添加附件',{exact:true}).setInputFiles([{name:'机柜正面.jpg',mimeType:'image/jpeg',buffer:Buffer.from([255,216,255,224,0,16])},{name:'机柜背面.jpg',mimeType:'image/jpeg',buffer:Buffer.from([255,216,255,224,0,17])}]);
  await dialog.getByText('机柜背面.jpg',{exact:true}).waitFor();await dialog.getByRole('button',{name:'不上传：机柜背面.jpg',exact:true}).click();
  await dialog.getByRole('button',{name:'保存',exact:true}).click();await p.getByText('随手记已保存',{exact:true}).waitFor();
  await row('现场配置记录').getByText('已有记录',{exact:true}).waitFor();await row('现场配置记录').getByText('随手记 1 条',{exact:true}).waitFor();
  await p.waitForFunction(m=>document.querySelector('[aria-label="项目模块"]').innerText.replace(/\s+/g,'').includes('项目资料缺'+m),missing-2);
  // Verbal agreement linked to a task from the task detail, then the timeline.
  const task=(await api('/records','POST',{project_id:project.id,task:'客户报表确认',owner:'胡示例三'},alice.cookie)).data.id;
  await p.getByRole('navigation',{name:'项目模块'}).getByRole('button',{name:'工作记录',exact:true}).click();await p.getByRole('button',{name:'客户报表确认',exact:true}).click();
  const detail=p.getByRole('dialog',{name:'任务详情'});await detail.getByText('暂无关联的文件或随手记',{exact:false}).waitFor();
  await detail.getByRole('button',{name:'记一条随手记',exact:true}).click();dialog=p.getByRole('dialog',{name:'记一条随手记'});
  await dialog.getByRole('button',{name:'口头约定',exact:true}).click();assert.equal(await dialog.getByLabel('关联任务（选填）',{exact:true}).inputValue(),task);
  await dialog.getByLabel('内容',{exact:true}).fill('客户张工电话确认：报表按月汇总即可');await dialog.getByRole('button',{name:'保存',exact:true}).click();
  await detail.getByText('客户张工电话确认：报表按月汇总即可',{exact:true}).waitFor();await detail.getByRole('button',{name:'关闭',exact:true}).first().click();
  await p.getByRole('navigation',{name:'项目模块'}).getByRole('button',{name:'随手记',exact:true}).click();
  const log=p.getByRole('region',{name:'随手记'});await log.getByText('客户张工电话确认：报表按月汇总即可',{exact:true}).waitFor();
  assert.deepEqual(await log.locator('h2 time').allTextContents(),[(await api('/projects/'+project.id+'/notes','GET',undefined,alice.cookie)).data.notes[0].occurred_on,'2026-10-19'],'grouped by occurred date, newest first');
  await log.getByText('机柜正面.jpg',{exact:true}).waitFor();assert.equal(await log.getByText('机柜背面.jpg',{exact:true}).count(),0);
  await log.getByRole('button',{name:'口头约定',exact:true}).click();assert.equal(await log.locator('[data-note-id]').count(),1);await log.getByRole('button',{name:'全部',exact:true}).click();
  await log.getByLabel('搜索随手记',{exact:true}).fill('机柜正面');assert.equal(await log.locator('[data-note-id]').count(),1);await log.getByLabel('搜索随手记',{exact:true}).fill('');
  // Edit keeps history; delete and restore.
  await log.getByRole('button',{name:/^编辑随手记：3 号柜/}).click();dialog=p.getByRole('dialog',{name:'编辑随手记'});await dialog.getByLabel('内容',{exact:true}).fill('3 号柜交换机 IP 改为 192.168.1.30');await dialog.getByRole('button',{name:'保存',exact:true}).click();
  await log.getByText('3 号柜交换机 IP 改为 192.168.1.30',{exact:true}).waitFor();
  p.once('dialog',d=>d.accept());await log.getByRole('button',{name:/^删除随手记：3 号柜/}).click();await log.getByText('已移入回收站，可在回收站恢复',{exact:true}).waitFor();
  await log.getByRole('button',{name:'回收站',exact:true}).click();await log.getByRole('button',{name:'恢复',exact:true}).click();await log.getByText('已恢复',{exact:true}).waitFor();
  const events=(await api('/resource-events?project_id='+project.id,'GET',undefined,alice.cookie)).data.entries;assert.equal(events.find(e=>e.action==='update-note').details.from,'3 号柜交换机 IP 改为 192.168.1.20（原 .10）');
  // Extend the checklist and save it as a template for the next similar project.
  await p.getByRole('navigation',{name:'项目模块'}).getByRole('button',{name:/项目资料/}).click();
  await checklist.getByRole('button',{name:'添加资料项',exact:true}).click();let edit=p.getByRole('dialog',{name:'添加交接资料项'});
  await edit.getByLabel('应交资料名称',{exact:true}).fill('消防验收意见');await edit.getByLabel('所属阶段',{exact:true}).selectOption('验收');await edit.getByLabel('必需资料',{exact:true}).check();await edit.getByRole('button',{name:'保存资料项',exact:true}).click();
  await row('消防验收意见').getByText('缺少资料',{exact:true}).waitFor();
  await checklist.getByRole('button',{name:'另存为模板',exact:true}).click();await p.getByRole('dialog',{name:'另存为清单模板'}).getByLabel('模板名称',{exact:true}).fill('园区改造');await p.getByRole('button',{name:'保存模板',exact:true}).click();
  await checklist.getByRole('button',{name:'园区改造',exact:true}).waitFor();
  await p.getByRole('button',{name:'新建项目',exact:true}).click();await p.getByLabel('项目名称',{exact:true}).fill('四号园区改造');const picker=p.getByLabel('资料清单',{exact:true});await picker.focus();
  await p.waitForFunction(()=>[...document.querySelectorAll('option')].some(o=>o.textContent==='模板：园区改造'));await picker.selectOption({label:'模板：园区改造'});
  await p.getByRole('button',{name:'创建项目',exact:true}).click();await p.getByText('已生成',{exact:false}).waitFor();
  const fourth=(await api('/state')).data.projects.find(x=>x.name==='四号园区改造');assert.ok((await api('/projects/'+fourth.id+'/deliverables','GET',undefined,alice.cookie)).data.items.some(i=>i.title==='消防验收意见'&&i.required&&i.stage==='验收'));
  // Mobile layouts stay within the viewport.
  await p.setViewportSize({width:390,height:844});
  for(const tab of [/项目资料/,'随手记']){await p.getByRole('navigation',{name:'项目模块'}).getByRole('button',{name:tab}).click();await p.waitForTimeout(300);const wide=await p.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>{if(e.getBoundingClientRect().right<=innerWidth+1)return false;for(let a=e.parentElement;a;a=a.parentElement)if(['auto','hidden','scroll','clip'].includes(getComputedStyle(a).overflowX))return false;return true;}).slice(0,8).map(e=>e.tagName+'.'+String(e.className).slice(0,60)+' '+(e.getAttribute('aria-label')||e.textContent.slice(0,20))+' r='+Math.round(e.getBoundingClientRect().right)).concat(['sw='+document.documentElement.scrollWidth]));assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,String(tab)+' '+JSON.stringify(wide));}
  assert.deepEqual(errors,[]);console.log('Handover browser passed: kind-based starter checklist, missing badge, stage-folder uploads and versions, site log with attachments satisfying items, task materials, timeline filters/search, edit history, recycle, custom templates and mobile layout.');
 }catch(e){if(p&&process.env.WORKLOG_QA_SCREENSHOT_DIR)await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'handover-failure.png')}).catch(()=>{});throw e;}
 finally{if(browser)await browser.close();if(app)await app.close();await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
