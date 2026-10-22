const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE_PATH||'playwright');
(async()=>{
 const {createApp}=await import(pathToFileURL(path.resolve(__dirname,'../server.mjs')).href);
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'worklog-browser-'));
 const origin='http://127.0.0.1:8768',base=origin+'/worklog/api';
 let app,browser,p;
 try{
  app=await createApp({ allowUninvitedRegistration: true,dataDir,origin,dist:path.resolve(__dirname,'../dist')});
  await new Promise(r=>app.server.listen(8768,'127.0.0.1',r));
  async function api(route,method='GET',body,cookie=''){
   const r=await fetch(base+route,{method,headers:{Origin:origin,'Content-Type':'application/json','X-Worklog-Request':'1',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});
   const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  const alice=await api('/register','POST',{login:'alice',name:'胡示例三',password:'Temporary-test-123'});
  const initial=(await api('/state')).data,project=initial.projects[0];
  const original=(await api('/records','POST',{project_id:project.id,task:'甲创建的工作',owner:'胡示例三',actual:'韩示例二',date:''},alice.cookie)).data;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});
  p=await context.newPage();const errors=[];p.on('pageerror',e=>{errors.push(e.message);console.error(e.stack)});
  await p.goto(origin+'/worklog/');await p.getByText('甲创建的工作',{exact:true}).waitFor();
  assert.equal(await p.getByRole('button',{name:'项目设置',exact:true}).count(),0);
  assert.equal(await p.getByRole('button',{name:/操作：/}).count(),0);
  await p.getByRole('button',{name:'登录 / 注册',exact:false}).click();
  await p.getByRole('button',{name:'注册账号',exact:true}).click();
  await p.getByLabel('你的姓名',{exact:true}).fill('韩示例二');await p.getByLabel('账号',{exact:true}).fill('bob');await p.getByLabel('密码',{exact:true}).fill('Temporary-test-123');
  await p.getByLabel('成员邀请码',{exact:true}).fill('a'.repeat(48));
  await p.getByLabel('你的姓名',{exact:true}).fill('名单外测试');
  await p.getByRole('button',{name:'注册并开始填写',exact:true}).click();
  await p.getByText('请填写真实姓名',{exact:true}).waitFor();
  assert.equal(app.db.prepare("SELECT id FROM users WHERE login='bob'").get(),undefined);
  await p.getByLabel('你的姓名',{exact:true}).fill('韩示例二');
  await p.getByRole('button',{name:'注册并开始填写',exact:true}).click();
  await p.getByRole('button',{name:'操作：甲创建的工作',exact:true}).waitFor();
  assert.equal(await p.getByRole('button',{name:'项目设置',exact:true}).count(),1);
  const bobCookies=(await context.cookies()).map(c=>c.name+'='+c.value).join(';');
  async function refreshInBackground(){const done=p.waitForResponse(r=>r.url()===base+'/state');await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await done;}
  async function openRecord(name){await p.getByRole('button',{name:'操作：'+name,exact:true}).click();await p.getByRole('button',{name:'编辑记录',exact:true}).click();}
  await openRecord('甲创建的工作');await p.getByLabel('工作事项',{exact:true}).fill('乙修改甲的工作');await p.getByRole('button',{name:'保存修改',exact:true}).click();await p.getByText('乙修改甲的工作',{exact:true}).waitFor();
  let record=(await api('/state')).data.records[0];assert.equal(record.creator,initial.user?.id||app.db.prepare('SELECT id FROM users WHERE login=?').get('alice').id);
  await openRecord('乙修改甲的工作');await p.getByLabel('工作事项',{exact:true}).fill('乙尚未保存的输入');
  await api('/records/'+record.id,'PATCH',{...record,task:'甲同时完成了修改'},alice.cookie);
  await refreshInBackground();
  await p.getByRole('button',{name:'保存修改',exact:true}).click();await p.getByRole('button',{name:'载入最新内容',exact:true}).waitFor();
  assert.equal(await p.getByLabel('工作事项',{exact:true}).inputValue(),'乙尚未保存的输入');
  assert.equal((await api('/state')).data.records[0].task,'甲同时完成了修改');
  await p.getByRole('button',{name:'载入最新内容',exact:true}).click();await p.waitForFunction(()=>document.querySelector('textarea[name=task]')?.value==='甲同时完成了修改');
  assert.equal(await p.getByLabel('工作事项',{exact:true}).inputValue(),'甲同时完成了修改');
  await p.getByLabel('工作事项',{exact:true}).fill('协作冲突处理完成');await p.getByRole('button',{name:'保存修改',exact:true}).click();await p.getByText('协作冲突处理完成',{exact:true}).waitFor();
  await p.getByRole('button',{name:'项目设置',exact:true}).click();await p.getByLabel('项目名称',{exact:true}).fill('乙的旧草稿');
  let current=(await api('/state')).data.projects[0];await api('/projects/'+current.id,'PATCH',{...current,name:'甲刚更新的项目',color:'emerald',members:['胡示例三','韩示例二']},alice.cookie);
  await refreshInBackground();await p.getByRole('button',{name:'保存设置',exact:true}).click();await p.getByRole('button',{name:'载入最新内容',exact:true}).waitFor();
  assert.equal((await api('/state')).data.projects[0].name,'甲刚更新的项目');
  assert.equal(await p.getByLabel('项目名称',{exact:true}).inputValue(),'乙的旧草稿');
  await p.getByRole('button',{name:'载入最新内容',exact:true}).click();await p.waitForFunction(()=>document.querySelector('input[name=name]')?.value==='甲刚更新的项目');
  assert.equal(await p.getByLabel('项目名称',{exact:true}).inputValue(),'甲刚更新的项目');
  assert.equal(await p.getByRole('button',{name:'青绿',exact:true}).getAttribute('aria-pressed'),'true');
  await p.getByLabel('项目名称',{exact:true}).fill('乙确认后的项目');await p.getByRole('button',{name:'保存设置',exact:true}).click();await p.getByRole('button',{name:'乙确认后的项目',exact:true}).waitFor();
  // Every swatch keeps its real color and hit area; saved project highlights use it too.
  const colors=[['indigo','靛紫','79, 70, 229'],['emerald','青绿','5, 150, 105'],['amber','琥珀','217, 119, 6'],['rose','玫红','225, 29, 72'],['sky','天蓝','2, 132, 199'],['violet','罗兰','124, 58, 237']];
  for(let i=0;i<colors.length;i++){
   const [id,label,rgb]=colors[i];
   await p.setViewportSize(i>=3?{width:320,height:740}:{width:1280,height:900});
   await p.getByRole('button',{name:'项目设置',exact:true}).click();
   await p.getByRole('dialog').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
   const swatch=p.getByRole('button',{name:label,exact:true});
   const before=await swatch.evaluate(e=>({fill:getComputedStyle(e.firstElementChild).backgroundImage,box:e.getBoundingClientRect().toJSON()}));
   await swatch.click();
   assert.equal(await swatch.getAttribute('aria-pressed'),'true');
   assert.equal(await p.locator('dialog button[aria-pressed=true]').count(),1);
   const after=await swatch.evaluate(e=>({fill:getComputedStyle(e.firstElementChild).backgroundImage,box:e.getBoundingClientRect().toJSON(),opacity:getComputedStyle(e).opacity}));
   assert.equal(after.fill,before.fill,'Selecting must not alter the color');
   assert.equal(after.opacity,'1');
   assert.equal(after.box.width,before.box.width);assert.equal(after.box.height,before.box.height);
   assert.ok(after.box.width>=44&&after.box.height>=44);
   assert.ok(after.box.x>=0&&after.box.right<=(i>=3?320:1280));
   if(id==='amber'&&process.env.WORKLOG_QA_SCREENSHOT_DIR){await fs.mkdir(process.env.WORKLOG_QA_SCREENSHOT_DIR,{recursive:true});await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'colors-desktop.png'),animations:'disabled'});}
   if(id==='violet'&&process.env.WORKLOG_QA_SCREENSHOT_DIR)await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'colors-mobile.png'),animations:'disabled'});
   await p.getByRole('button',{name:'保存设置',exact:true}).click();
   await p.getByRole('dialog').waitFor({state:'hidden'});
   await p.waitForFunction(rgb=>getComputedStyle(document.querySelector('.project-nav button[aria-current=page]')).backgroundImage.includes(rgb),rgb);
   assert.equal((await api('/state')).data.projects.find(x=>x.id===project.id).color,id);
   await p.reload();await p.getByRole('button',{name:'项目设置',exact:true}).click();
   assert.equal(await p.getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed'),'true');
   assert.ok((await p.locator('.project-nav button[aria-current=page]').evaluate(e=>getComputedStyle(e).backgroundImage)).includes(rgb));
   await p.getByRole('button',{name:'取消',exact:true}).click();
  }
  await p.setViewportSize({width:1280,height:900});
  await p.getByRole('button',{name:'项目设置',exact:true}).click();await p.getByRole('button',{name:'琥珀',exact:true}).click();await p.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal((await api('/state')).data.projects.find(x=>x.id===project.id).color,'violet','Cancelled color stays unsaved');
  // A work item can be submitted with both completion fields empty, then completed later.
  await p.getByRole('button',{name:'记录完成',exact:true}).click();
  await p.getByLabel('工作事项',{exact:true}).fill('未完成也可提交');
  await p.getByRole('group',{name:'原定负责人（可多选）',exact:true}).getByRole('button',{name:'胡示例三',exact:false}).click();
  await p.getByRole('group',{name:'原定负责人（可多选）',exact:true}).getByRole('button',{name:'韩示例二',exact:false}).click();
  assert.equal(await p.getByRole('group',{name:'实际完成人（可多选）',exact:true}).locator('button[aria-pressed=true]').count(),0);
  assert.equal(await p.locator('input[name=date]').inputValue(),'');
  assert.equal(await p.locator('input[name=date]').getAttribute('required'),null);
  assert.equal(await p.getByRole('button',{name:'提交记录',exact:true}).isEnabled(),true);
  await p.getByRole('button',{name:'提交记录',exact:true}).click();await p.getByText('未完成也可提交',{exact:true}).waitFor();
  const pendingRow=()=>p.getByRole('row').filter({hasText:'未完成也可提交'});
  assert.equal(await pendingRow().getByRole('cell').nth(2).innerText(),'—');
  assert.equal(await pendingRow().getByRole('cell').nth(3).innerText(),'未完成');
  assert.equal(await pendingRow().getByText('本人完成',{exact:true}).count(),0);
  assert.equal((await api('/state')).data.records.find(r=>r.task==='未完成也可提交').actual,'');
  assert.equal((await api('/state')).data.records.find(r=>r.task==='未完成也可提交').owner,'胡示例三、韩示例二');
  assert.equal((await p.locator('.stats-grid > div').first().innerText()).includes('1 项'),true);
  await p.reload();await pendingRow().getByText('未完成',{exact:true}).waitFor();
  await p.getByRole('tab',{name:'按人汇总',exact:true}).click();
  const ownerCard=p.locator('.person-grid > div').filter({has:p.getByText('胡示例三',{exact:true})});
  await ownerCard.getByText('未完成 1 项',{exact:true}).waitFor();await ownerCard.locator('summary').click();await ownerCard.getByText('未完成也可提交',{exact:true}).waitFor();
  await p.getByRole('tab',{name:'完成明细',exact:true}).click();
  await p.getByRole('button',{name:'选择月份：全部日期',exact:true}).click();await p.getByRole('button',{name:'未完成',exact:true}).click();
  await pendingRow().getByText('未完成',{exact:true}).waitFor();
  if(process.env.WORKLOG_QA_SCREENSHOT_DIR){await fs.mkdir(process.env.WORKLOG_QA_SCREENSHOT_DIR,{recursive:true});await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'pending-desktop.png'),animations:'disabled'});}
  await openRecord('未完成也可提交');
  assert.equal(await p.getByRole('group',{name:'原定负责人（可多选）',exact:true}).locator('button[aria-pressed=true]').count(),2);
  // Date alone is sufficient: no actual completer needs to be selected.
  await p.locator('input[name=date]').fill('2026-10-15');await p.getByRole('button',{name:'保存修改',exact:true}).click();
  await p.getByRole('dialog').waitFor({state:'hidden'});await pendingRow().waitFor({state:'hidden'});
  await p.getByRole('button',{name:'选择月份：未完成',exact:true}).click();await p.getByRole('button',{name:'全部日期',exact:true}).click();
  await pendingRow().getByRole('cell').nth(3).locator('time').waitFor();assert.equal(await pendingRow().getByRole('cell').nth(2).innerText(),'—');
  assert.equal((await p.locator('.stats-grid > div').first().innerText()).includes('2 项'),true);
  // Completer alone is also sufficient: date stays truly blank after save/reload.
  await openRecord('未完成也可提交');await p.locator('input[name=date]').fill('');
  await p.getByRole('group',{name:'实际完成人（可多选）',exact:true}).getByRole('button',{name:'韩示例二',exact:false}).click();
  await p.getByRole('button',{name:'保存修改',exact:true}).click();await p.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await pendingRow().getByRole('cell').nth(3).innerText(),'');
  assert.equal((await p.locator('.stats-grid > div').first().innerText()).includes('2 项'),true);
  await p.reload();await pendingRow().waitFor();assert.equal(await pendingRow().getByRole('cell').nth(3).innerText(),'');
  await p.getByRole('button',{name:'选择月份：全部日期',exact:true}).click();await p.getByRole('button',{name:'未完成',exact:true}).click();await pendingRow().waitFor({state:'hidden'});
  await p.getByRole('button',{name:'选择月份：未完成',exact:true}).click();await p.getByRole('button',{name:'全部日期',exact:true}).click();
  // Only clearing both fields puts the work item back into pending.
  await openRecord('未完成也可提交');await p.getByRole('group',{name:'实际完成人（可多选）',exact:true}).getByRole('button',{name:'韩示例二',exact:false}).click();
  await p.getByRole('button',{name:'保存修改',exact:true}).click();await pendingRow().getByText('未完成',{exact:true}).waitFor();
  assert.equal(await pendingRow().getByRole('cell').nth(2).innerText(),'—');
  await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.WORKLOG_QA_SCREENSHOT_DIR)await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'pending-mobile.png'),animations:'disabled'});
  await p.setViewportSize({width:1280,height:900});
  let blockSync=false;await p.route('**/worklog/api/state',route=>blockSync?route.abort('failed'):route.continue());
  await p.getByRole('button',{name:'记录完成',exact:true}).click();await p.getByLabel('工作事项',{exact:true}).fill('保存成功但同步断网');
  await p.getByRole('group',{name:'原定负责人（可多选）',exact:true}).getByRole('button',{name:'胡示例三',exact:false}).click();
  blockSync=true;await p.getByRole('button',{name:'提交记录',exact:true}).click();
  await p.getByText('记录已提交；列表同步失败，请点重试',{exact:true}).waitFor();assert.equal(await p.getByRole('dialog').count(),0);
  assert.equal((await api('/state')).data.records.filter(r=>r.task==='保存成功但同步断网').length,1);
  blockSync=false;await p.getByRole('button',{name:'重试',exact:true}).click();await p.getByText('保存成功但同步断网',{exact:true}).waitFor();
  await p.getByRole('button',{name:'新建项目',exact:true}).click();await p.getByLabel('项目名称',{exact:true}).fill('同步失败仍成功创建的项目');blockSync=true;
  await p.getByRole('button',{name:'创建项目',exact:true}).click();await p.getByText('项目已创建；列表同步失败，请点重试',{exact:true}).waitFor();assert.equal(await p.getByRole('dialog').count(),0);
  assert.equal((await api('/state')).data.projects.filter(r=>r.name==='同步失败仍成功创建的项目').length,1);
  blockSync=false;await p.getByRole('button',{name:'重试',exact:true}).click();await p.getByRole('button',{name:'同步失败仍成功创建的项目',exact:true}).waitFor();
  await p.getByRole('button',{name:'乙确认后的项目',exact:true}).click();await p.getByRole('button',{name:'操作：协作冲突处理完成',exact:true}).click();await p.getByRole('button',{name:'删除记录',exact:true}).click();await p.getByRole('button',{name:'确认删除',exact:true}).click();await p.getByRole('button',{name:'撤销',exact:true}).click();await p.getByText('协作冲突处理完成',{exact:true}).waitFor();
  assert.deepEqual(await p.locator('th').allTextContents(),['工作事项','原定负责人','实际完成人','完成日期','操作']);
  await p.evaluate(()=>{window.__qaDrawnText=[];const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__qaDrawnText.push(String(text));return original.call(this,text,...args);};});
  await p.getByRole('button',{name:'导出图片',exact:true}).click();await p.getByRole('button',{name:'生成图片',exact:true}).click();await p.getByRole('img',{name:'工作完成记录导出图片'}).waitFor();
  assert.ok(await p.evaluate(()=>window.__qaDrawnText.includes('未完成')),'PNG export must show pending status');
  const dlPromise=p.waitForEvent('download');await p.getByRole('button',{name:'下载图片',exact:true}).click();const dl=await dlPromise;const file=path.join(dataDir,'export.png');await dl.saveAs(file);assert.ok((await fs.stat(file)).size>10000);await p.getByRole('button',{name:'关闭',exact:true}).click();
  await p.getByRole('tab',{name:'按人汇总',exact:true}).click();await p.getByRole('tabpanel',{name:'按人汇总',exact:true}).getByText('韩示例二',{exact:true}).waitFor();
  await p.getByRole('tab',{name:'完成明细',exact:true}).click();await p.getByRole('button',{name:'截图模式',exact:true}).click();assert.equal(await p.locator('aside').isVisible(),false);await p.getByRole('button',{name:'退出截图模式 · Esc',exact:true}).click();
  await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.setViewportSize({width:1280,height:900});
  await p.locator('aside').getByRole('button').filter({hasText:'韩示例二'}).click();await p.getByRole('button',{name:'退出登录',exact:true}).click();await p.getByRole('button',{name:'登录 / 注册',exact:false}).waitFor();assert.equal(await p.getByRole('button',{name:/操作：/}).count(),0);assert.equal(await p.getByRole('button',{name:'项目设置',exact:true}).count(),0);
  // Populate enough immutable history to exercise cursor pagination with no real server data.
  const latest=(await api('/state')).data.records.find(r=>r.id===original.id);
  for(let i=0;i<25;i++)await api('/records/'+latest.id,'PATCH',{...latest,version:latest.version+i},alice.cookie);
  await p.getByRole('tab',{name:'操作日志',exact:true}).click();
  const logs=p.getByRole('tabpanel',{name:'操作日志',exact:true});
  await logs.getByText('不可修改或删除',{exact:true}).waitFor();
  await p.waitForFunction(()=>document.querySelectorAll('[data-log-id]').length===20);
  assert.equal(await logs.getByRole('button',{name:/删除日志|清空日志|编辑日志/}).count(),0);
  await logs.getByRole('button',{name:'加载更早日志',exact:true}).click();
  await p.waitForFunction(()=>document.querySelectorAll('[data-log-id]').length>20);
  const scoped=(await api('/logs?project='+project.id)).data;
  while(await p.locator('[data-log-id]').count()<scoped.total){const count=await p.locator('[data-log-id]').count();await logs.getByRole('button',{name:'加载更早日志',exact:true}).click();await p.waitForFunction(count=>document.querySelectorAll('[data-log-id]').length>count,count);}
  assert.equal(await p.locator('[data-log-id]').count(),scoped.total);
  assert.equal(new Set(await p.locator('[data-log-id]').evaluateAll(els=>els.map(e=>e.dataset.logId))).size,scoped.total);
  await logs.getByText('删除记录',{exact:true}).first().waitFor();
  await logs.getByText('撤销删除',{exact:true}).first().waitFor();
  const actors=await logs.locator('article header strong').allTextContents();assert.ok(actors.includes('胡示例三'));assert.ok(actors.includes('韩示例二'));
  await logs.getByRole('button',{name:'全部项目',exact:true}).click();
  const global=(await api('/logs')).data;
  await logs.getByText('共 '+global.total+' 条 · 按操作时间倒序',{exact:true}).waitFor();
  assert.ok(global.total>scoped.total);
  let failLogs=true;await p.route('**/worklog/api/logs**',route=>failLogs?route.abort('failed'):route.continue());
  await logs.getByRole('button',{name:'刷新日志',exact:true}).click();await logs.getByRole('alert').waitFor();
  failLogs=false;await logs.getByRole('button',{name:'刷新日志',exact:true}).click();await logs.getByText('共 '+global.total+' 条 · 按操作时间倒序',{exact:true}).waitFor();
  await p.setViewportSize({width:390,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.WORKLOG_QA_SCREENSHOT_DIR){await fs.mkdir(process.env.WORKLOG_QA_SCREENSHOT_DIR,{recursive:true});await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'logs-mobile.png'),fullPage:true,animations:'disabled'});await p.setViewportSize({width:1280,height:900});await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'logs-desktop.png'),fullPage:true,animations:'disabled'});}
  // Public viewers can paginate and sort without changing shared records.
  const listProject=(await api('/projects','POST',{name:'分页排序验收',color:'sky',members:['胡示例三','韩示例二']},alice.cookie)).data;
  for(let i=1;i<=27;i++)await api('/records','POST',{project_id:listProject.id,task:'排序验收'+String(i).padStart(2,'0'),owner:i===1?'胡示例三、韩示例二':'胡示例三',actual:i<=25?'胡示例三':'',date:i<=25?'2026-10-'+String(i).padStart(2,'0'):''},alice.cookie);
  await p.reload();await p.getByRole('button',{name:'分页排序验收',exact:true}).click();
  const rowTasks=()=>p.locator('.record-table [data-task-title]').allTextContents();
  await p.getByLabel('每页显示条数',{exact:true}).waitFor();
  assert.equal(await p.getByLabel('每页显示条数',{exact:true}).inputValue(),'5');
  assert.equal(await p.locator('.record-table tbody tr').count(),5);assert.equal((await rowTasks())[0],'排序验收25');
  await p.getByRole('button',{name:'第 6 页',exact:true}).click();assert.equal(await p.locator('.record-table tbody tr').count(),2);
  await p.getByLabel('每页显示条数',{exact:true}).selectOption('10');assert.equal(await p.getByRole('button',{name:'第 1 页',exact:true}).getAttribute('aria-current'),'page');assert.equal(await p.locator('.record-table tbody tr').count(),10);
  for(const size of ['20','50','100']){await p.getByLabel('每页显示条数',{exact:true}).selectOption(size);assert.equal(await p.locator('.record-table tbody tr').count(),Math.min(27,Number(size)));}
  async function selectOrder(label){await p.getByRole('button',{name:/^列表排序：/}).click();await p.getByRole('menuitemradio',{name:label,exact:true}).click();}
  await selectOrder('完成日期 · 从旧到新');let tasks=await rowTasks();assert.equal(tasks[0],'排序验收01');assert.ok(tasks.slice(-2).every(t=>['排序验收26','排序验收27'].includes(t)));
  await selectOrder('完成日期 · 从新到旧');assert.equal((await rowTasks())[0],'排序验收25');
  await selectOrder('登记时间 · 从旧到新');assert.equal((await rowTasks())[0],'排序验收01');
  await selectOrder('登记时间 · 从新到旧');assert.equal((await rowTasks())[0],'排序验收27');
  await selectOrder('工作事项 · 降序');assert.equal((await rowTasks())[0],'排序验收27');
  await selectOrder('工作事项 · 升序');assert.equal((await rowTasks())[0],'排序验收01');
  for(const label of ['原定负责人 · 升序','原定负责人 · 降序','实际完成人 · 升序','实际完成人 · 降序']){await selectOrder(label);assert.equal(await p.locator('.record-table tbody tr').count(),27);}
  await p.getByLabel('每页显示条数',{exact:true}).selectOption('10');await p.getByRole('button',{name:'第 2 页',exact:true}).click();
  await selectOrder('工作事项 · 升序');assert.equal(await p.getByRole('button',{name:'第 1 页',exact:true}).getAttribute('aria-current'),'page');
  await p.getByRole('button',{name:'第 3 页',exact:true}).click();await p.getByRole('textbox',{name:'搜索工作或姓名',exact:true}).fill('排序验收01');
  assert.equal(await p.locator('.record-table tbody tr').count(),1);assert.equal(await p.getByRole('button',{name:'第 1 页',exact:true}).getAttribute('aria-current'),'page');
  await selectOrder('登记时间 · 从旧到新');assert.equal(await p.getByRole('textbox',{name:'搜索工作或姓名',exact:true}).inputValue(),'排序验收01');
  await p.getByRole('button',{name:'清空搜索',exact:true}).click();await p.reload();await p.getByLabel('每页显示条数',{exact:true}).waitFor();
  assert.equal(await p.getByLabel('每页显示条数',{exact:true}).inputValue(),'10');await p.getByRole('button',{name:'列表排序：登记时间 · 从旧到新',exact:true}).waitFor();
  const jsonDownload=p.waitForEvent('download');await p.getByRole('button',{name:'导出数据',exact:true}).click();const jsonFile=path.join(dataDir,'ordered-export.json');await(await jsonDownload).saveAs(jsonFile);const exported=JSON.parse(await fs.readFile(jsonFile,'utf8'));assert.equal(exported.records.length,27);assert.equal(exported.records[0].task,'排序验收01');
  await p.getByRole('button',{name:'截图模式',exact:true}).click();assert.equal(await p.locator('.record-table tbody tr').count(),27);assert.equal(await p.getByLabel('每页显示条数',{exact:true}).count(),0);await p.getByRole('button',{name:'退出截图模式 · Esc',exact:true}).click();
  await p.evaluate(()=>localStorage.setItem('worklog-list-preferences','{"pageSize":0,"sort":"invalid"}'));await p.reload();await p.getByLabel('每页显示条数',{exact:true}).waitFor();assert.equal(await p.getByLabel('每页显示条数',{exact:true}).inputValue(),'5');await p.getByRole('button',{name:'列表排序：完成日期 · 从新到旧',exact:true}).waitFor();
  await selectOrder('工作事项 · 升序');
  if(process.env.WORKLOG_QA_SCREENSHOT_DIR){await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'list-desktop.png'),animations:'disabled'});await p.setViewportSize({width:390,height:844});await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'list-mobile.png'),fullPage:true,animations:'disabled'});}
  for(const width of [320,390]){await p.setViewportSize({width,height:844});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.getByRole('button',{name:/^列表排序：/}).click();await p.getByRole('menuitemradio',{name:'登记时间 · 从新到旧',exact:true}).click();await p.getByLabel('每页显示条数',{exact:true}).selectOption('10');assert.equal(await p.locator('.record-table tbody tr').count(),10);}
  // Four explicit combinations remain visible and count consistently across views.
  const statusProject=(await api('/projects','POST',{name:'完成规则验收',color:'emerald',members:['胡示例三','韩示例二']},alice.cookie)).data;
  const cases=[{task:'仅填写实际完成人',actual:'韩示例二',date:''},{task:'仅填写完成日期',actual:'',date:'2026-10-15'},{task:'完成人和日期均填写',actual:'韩示例二',date:'2026-10-15'},{task:'两项均未填写',actual:'',date:''}];
  for(const record of cases)await api('/records','POST',{...record,project_id:statusProject.id,owner:'胡示例三、韩示例二'},alice.cookie);
  await p.setViewportSize({width:1280,height:1000});await p.reload();await p.getByRole('button',{name:'完成规则验收',exact:true}).click();
  for(const record of cases){const row=p.getByRole('row').filter({hasText:record.task});await row.waitFor();const cell=row.getByRole('cell').nth(3);if(record.date)assert.equal(await cell.locator('time').getAttribute('datetime'),record.date);else assert.equal(await cell.innerText(),record.actual?'':'未完成');}
  assert.equal((await p.locator('.stats-grid > div').first().innerText()).includes('3 项'),true);
  assert.equal(await p.locator('.record-table tbody').getByText('未完成',{exact:true}).count(),1);
  await p.getByRole('tab',{name:'按人汇总',exact:true}).click();const namedCard=p.locator('.person-grid > div').filter({has:p.getByText('韩示例二',{exact:true})});await namedCard.getByText('完成人未填 1 项',{exact:true}).waitFor();await namedCard.getByText('2',{exact:true}).waitFor();await p.getByRole('tab',{name:'完成明细',exact:true}).click();
  if(process.env.WORKLOG_QA_SCREENSHOT_DIR)await p.screenshot({path:path.join(process.env.WORKLOG_QA_SCREENSHOT_DIR,'completion-cases.png'),animations:'disabled'});
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Passed: configurable page size, ten sort orders, saved preferences, pagination/filter reset, full ordered export, mobile controls and multi-owner submission; either date or completer marks completion, blank completion date stays blank, both empty submission and pending display, counts, filters, filling in completion, clearing both fields and mobile; all six project colors, stable swatches, mobile taps, save/reload/sidebar highlight, cancelled changes; cross-member editing, all-project settings, concurrent record/project conflict recovery after background sync, no duplicate records/projects on failed sync, deletion/undo, public read-only, PNG export, optional date last, people summary, screenshot mode and mobile layout; approved-name signup, exact rejection text, public immutable logs, all-project history, pagination and log fetch recovery');
 }catch(e){if(p)console.log((await p.locator('body').innerText()).slice(-5000));throw e;}finally{await browser?.close();await app?.close();await fs.rm(dataDir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
