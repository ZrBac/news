const {chromium,devices}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const base=process.env.NEWS_BASE_URL || 'http://127.0.0.1:8767';
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
  const context=await browser.newContext({...devices['iPhone 13']});
  await context.addInitScript(require('./legacy-safari.cjs'));
  await context.addInitScript(()=>Date.now=()=>Date.parse('2026-11-06T11:30:00Z'));
  let profile={schema:1,settings:{},records:[]};
  await context.route('**/api/outings/profile',async r=>{
   if(r.request().method()==='POST'){const p=r.request().postDataJSON();if(p.action==='record')profile.records=[{...p,updatedAt:new Date().toISOString()},...profile.records.filter(x=>x.id!==p.id)];else if(p.action==='remove')profile.records=profile.records.filter(x=>x.id!==p.id);}
   await r.fulfill({json:profile});
  });
  await context.route('**/api/outings/journal*',r=>r.fulfill({json:{schema:1,version:0,records:[]}}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const data=await (await page.request.get(base+'/data/latest.json')).json();
  const id='auto-abcdef0123456789';
  const place={id,name:'杭州新陶艺工坊',area:'杭州西湖区',group:'rainy',dynamic:true,aliases:['新陶艺工坊'],paragraphs:[{text:'两个人在室内做陶艺，按自己的想法捏一只杯子。'}],links:[{label:'来源原文',url:'https://example.com/new-workshop'}],reviewedOn:'2026-11-06',addedAt:'2026-11-06T08:00:00Z',verifiedAt:'2026-11-06T08:00:00Z',sourceStatus:'verified'};
  data.editorial=data.editorial||{};
  data.editorial.placeCatalog={updatedAt:'2026-11-06T08:00:00Z',places:[place]};
  const day={date:'2026-11-07',code:61,low:12,high:18,rainProbability:90,rainMm:8,windKmh:8};
  data.editorial.trip={updatedAt:'2026-11-06T08:00:00Z',status:'ok',weekendStart:'2026-11-07',weekendEnd:'2026-11-08',weather:{updatedAt:'2026-11-06T08:00:00Z',regions:{hangzhou:{name:'杭州',days:[day,{...day,date:'2026-11-08'}]}}},picks:[],alternatives:[{...place,id:'place:'+id,placeId:id,type:'rainy',setting:'indoor',region:'hangzhou',day:'2026-11-07',discovery:false,reason:'周六有雨，可在室内制作陶艺。',summary:'两人亲手做一只杯子。',sources:place.links}]};
  data.eveningWeather={updatedAt:'2026-11-06T11:00:00Z',hours:[19,20,21,22].map(h=>({time:`2026-11-06T${h}:00`,rainProbability:5,rainMm:0,windKmh:5,code:1}))};
  data.weekendArticles=[{id:'museum',title:'杭州博物馆新展',url:'https://example.com/museum',category:'local',sourceId:'web-discovery',publishedAt:'2026-11-06T01:00:00Z',outing:{type:'culture'}},{id:'market',title:'杭州周末手作市集',url:'https://example.com/market',category:'local',sourceId:'web-discovery',publishedAt:'2026-11-06T02:00:00Z',outing:{type:'market',start:'2026-11-07',end:'2026-11-08'}}];
  await page.route('**/data/latest.json*',r=>r.fulfill({json:data}));
  await page.goto(base+'/#local');await page.evaluate(()=>window.newsInitialLoad);
  assert.equal(await page.locator('.trip-backups').count(),0);
  assert.match(await page.locator('#outing-recommendations').innerText(),/新收录/);
  assert.equal(await page.locator('#outing-news-panel').getAttribute('open'),null);
  assert(await page.locator('#search').isHidden());
  await page.locator('#outing-library > summary').click();
  await page.locator('#search').fill('新陶艺工坊');
  const card=page.locator(`[data-place-id="${id}"]`);await card.waitFor();
  assert.match(await card.innerText(),/11\/06 收录/);
  await card.locator('[data-place-feedback="want"]').click();
  await page.waitForFunction(()=>OutingProfile.snapshot().pending.length===0);
  await page.locator('#outing-records-trigger').click();await page.locator('.record-want > summary').click();
  assert.match(await page.locator('.record-want').innerText(),/杭州新陶艺工坊/);
  assert.equal(profile.records[0].url,'https://example.com/new-workshop');
  await page.locator('#search').fill('博物馆');
  await page.waitForFunction(()=>!document.querySelector('[data-article-id="museum"]'));
  await page.locator('[data-outing-mode="tonight"]').click();await page.locator('#tonight-plans').waitFor();
  assert(await page.locator('[data-tonight-id="event:tonight-nearby-walk"]').count(), 'rainy daytime does not hide a dry evening walk');
  assert.equal(await page.locator('#outing-records').count(),1);
  for(const width of [320,390,1440]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  assert.deepEqual(errors,[]);await context.close();
  console.log('Living outings passed: source-backed additions, shared wanted places, exclusions, single records entry, hourly evening weather and layout');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
