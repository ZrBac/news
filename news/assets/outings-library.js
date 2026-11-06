/* Place references and current discoveries share feedback and one catalog. */
(function () {
  'use strict';
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rules = window.NewsPlaces?.rules || {};
  const excluded = new RegExp([rules.excluded,rules.noise].filter(Boolean).join('|') || '(?!)','i');
  let current = [], lastSignature = '';
  function safe(value) { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch (_) { return ''; } }
  function controls(p) {
    const status = window.OutingProfile?.snapshot().records.find(r=>r.id==='place:'+p.id)?.status;
    return `<div class="trip-feedback place-feedback">${Object.entries({want:'想去',visited:'去过',dismiss:'不感兴趣'}).map(([key,label])=>`<button class="text-button" data-place-feedback="${key}" aria-pressed="${status===key}">${label}</button>`).join('')}</div>`;
  }
  function card(p) {
    const paragraphs = Array.isArray(p.paragraphs)?p.paragraphs:[];
    return `<span class="place-area">${esc(p.area)}</span><h3>${esc(p.name)}</h3><p>${esc(paragraphs[0]?.text)}</p>
      <details class="place-details"><summary>地点条件与来源</summary>${paragraphs.slice(1).map(x=>`<p>${esc(x.label)}${esc(x.text)}</p>`).join('')}
      <p class="place-note">新收录的常设地点；营业、课程、费用与用炉条件以场地方当天确认为准。</p>
      <div class="place-links">${(p.links||[]).filter(l=>safe(l.url)).map(l=>`<a href="${esc(safe(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join('')}</div>
      <p class="place-reviewed">来源核对 ${esc(p.reviewedOn)}${p.sourceStatus!=='verified'?' · '+esc({closed:'来源有停用提示，暂不推荐',changed:'来源内容有变化，暂不推荐',unavailable:'来源暂不可读，暂不推荐'}[p.sourceStatus]||'本次未完成复核'):''}</p>
      <div class="place-updates" data-place-updates></div></details>${controls(p)}`;
  }
  function render(data, formatTime) {
    const catalog = data.editorial?.placeCatalog || {}, updates = data.placeUpdates?.places || {};
    const base = window.NewsPlaces?.places || [];
    const dynamic = (catalog.places || []).filter(p=>p && /^auto-[a-f0-9]{16}$/.test(p.id) && ['rainy','camping','hiking','cycling'].includes(p.group) && !excluded.test(p.name) && Array.isArray(p.links));
    current = base.concat(dynamic);
    const profile = window.OutingProfile?.snapshot().records || [];
    const signature = JSON.stringify([catalog,updates,profile.map(r=>[r.id,r.status])]);
    if(signature === lastSignature) return;
    lastSignature = signature;
    document.querySelectorAll('[data-dynamic-place]').forEach(node=>{if(!dynamic.some(p=>p.id===node.dataset.placeId))node.remove();});
    for(const p of current) {
      let node = document.querySelector(`[data-place-id="${p.id}"]`);
      if(!node) {
        node = document.createElement('li');node.className='place-card';node.dataset.placeId=p.id;node.dataset.dynamicPlace='true';
        node.dataset.placeTypes=p.types || 'outdoor';node.dataset.search=p.keywords || p.name;
        const list = document.querySelector(`#${p.group}-list`);if(!list)continue;list.append(node);
        node.innerHTML=card(p);
      } else if(p.dynamic) {
        const open=node.querySelector('details')?.open;node.innerHTML=card(p);node.querySelector('details').open=!!open;
      }
      const old=node.querySelector('.place-feedback');
      if(old)old.outerHTML=controls(p);else node.insertAdjacentHTML('beforeend',controls(p));
      const tag=node.querySelector('.place-freshness');if(tag)tag.remove();
      const recent=updates[p.id]?.items?.[0];
      const text=p.dynamic?`${(p.addedAt||'').slice(5,10).replace('-','/')} 收录` : recent?'有近期消息':'';
      if(text)node.insertAdjacentHTML('afterbegin',`<p class="place-freshness">${esc(text)}</p>`);
    }
    const weekly = Math.floor(Date.now() / 604800000);
    const hash=value=>{let h=0;for(const c of value)h=(Math.imul(h,31)+c.charCodeAt(0))>>>0;return h;};
    const score=p=>{
      const record=profile.find(r=>r.id==='place:'+p.id);
      return [record?.status==='dismiss'?2:record?.status==='visited'?1:0,
        record?.status==='want'?0:1, p.dynamic?0:1,
        -(Date.parse(updates[p.id]?.items?.[0]?.publishedAt || p.addedAt)||0),hash(weekly+p.id)];
    };
    const compare=(a,b)=>{const x=score(a),y=score(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;};
    for(const group of ['hiking','cycling','rainy','camping']) {
      const list=document.querySelector(`#${group}-list`);
      current.filter(p=>p.group===group).sort(compare).forEach(p=>{const node=document.querySelector(`[data-place-id="${p.id}"]`);if(node)list.append(node);});
    }
    const recent=dynamic.filter(p=>Date.now()-Date.parse(p.addedAt)<14*86400000).slice(0,6);
    const changes=current.map(p=>({p,item:updates[p.id]?.items?.[0]})).filter(x=>x.item && Date.now()-Date.parse(x.item.publishedAt)<30*86400000).sort((a,b)=>Date.parse(b.item.publishedAt)-Date.parse(a.item.publishedAt)).slice(0,3);
    const panel=document.querySelector('#outing-library-updates');panel.hidden=!recent.length&&!changes.length;
    const open=panel.querySelector('details')?.open;
    panel.innerHTML=`<details${open?' open':''}><summary>最近收录与地点消息${recent.length?' · '+recent.length+' 个新收录':''}</summary>
      ${recent.map(p=>`<p><button class="text-button" data-trip-place="${p.id}">${esc(p.name)}</button> <span class="trip-note">${esc(formatTime(p.addedAt))} 收录</span></p>`).join('')}
      ${changes.map(({p,item})=>`<p><button class="text-button" data-trip-place="${p.id}">${esc(p.name)}</button>：${esc(item.title.replace(/ - [^-]+$/,''))} <span class="trip-note">${esc(formatTime(item.publishedAt))} 报道</span></p>`).join('')}</details>`;
    document.querySelector('#place-catalog-status').textContent=catalog.updatedAt?`${current.length} 个 · 最近检索 ${formatTime(catalog.updatedAt)}`:`${current.length} 个地点参考`;
  }
  function articleRecord(a) {
    return {id:a.outingId || 'event:story-'+a.id.replace(/[^a-z0-9-]/gi,'').slice(0,65),name:a.outing?.eventName || a.title,
      area:a.outing?.venue || '',day:a.outing?.start || '',url:a.originalUrl || a.url};
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-place-feedback]');if(!button)return;
    const p=current.find(p=>p.id===button.closest('[data-place-id]').dataset.placeId);if(!p)return;
    window.OutingProfile.mark({id:'place:'+p.id,name:p.name,area:p.area,url:p.links?.find(l=>!l.url.includes('uri.amap.com'))?.url},button.dataset.placeFeedback);
  });
  window.OutingLibrary={render,excluded,places:()=>current,articleRecord,safe};
})();
