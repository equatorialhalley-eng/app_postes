/* Inventário Inteligente de Postes — v0
   NT.00016.EQTL · PRODEPA / HALLEY
   Identificação do poste por posição + rumo (não por imagem).
   Funciona offline. Dados em IndexedDB. Exporta ZIP para o dossiê. */
'use strict';
const VERSAO = 'v0.9';

/* ---------- 1. Persistência ---------- */
const DB_NOME = 'invpostes', DB_VER = 1;
let _db = null;
function abrirDb(){
  return new Promise((res, rej) => {
    if (_db) return res(_db);
    const r = indexedDB.open(DB_NOME, DB_VER);
    r.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('fotos')) d.createObjectStore('fotos');
    };
    r.onsuccess = e => { _db = e.target.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(k){
  try{ const d = await abrirDb();
    return await new Promise((res,rej)=>{ const q=d.transaction('kv').objectStore('kv').get(k);
      q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); });
  }catch(e){ console.warn('kvGet',e); return undefined; }
}
async function kvSet(k,v){
  try{ const d = await abrirDb();
    return await new Promise((res,rej)=>{ const t=d.transaction('kv','readwrite');
      t.objectStore('kv').put(v,k); t.oncomplete=()=>res(true); t.onerror=()=>rej(t.error); });
  }catch(e){ console.warn('kvSet',e); toast('Falha ao gravar no aparelho'); return false; }
}
async function fotoSet(k,blob){
  try{ const d = await abrirDb();
    return await new Promise((res,rej)=>{ const t=d.transaction('fotos','readwrite');
      t.objectStore('fotos').put(blob,k); t.oncomplete=()=>res(true); t.onerror=()=>rej(t.error); });
  }catch(e){ console.warn('fotoSet',e); toast('Falha ao gravar foto'); return false; }
}
async function fotoGet(k){
  try{ const d = await abrirDb();
    return await new Promise((res,rej)=>{ const q=d.transaction('fotos').objectStore('fotos').get(k);
      q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); });
  }catch(e){ return undefined; }
}
async function fotosLimpar(){
  try{ const d = await abrirDb();
    return await new Promise((res,rej)=>{ const t=d.transaction('fotos','readwrite');
      t.objectStore('fotos').clear(); t.oncomplete=()=>res(true); t.onerror=()=>rej(t.error); });
  }catch(e){ return false; }
}

/* ---------- 2. Estado ---------- */
const CFG_PADRAO = { os:'', projeto:'', municipio:'', offE:0, offN:0, k:0.35, nitidez:60, maxPx:1600, jpeg:0.82, bussolaOff:0 };
let cfg = Object.assign({}, CFG_PADRAO);
let postes = [];              // base do pacote de campo
let regs = {};                // barramento -> registro
let pos = null;               // GeolocationPosition
let rumo = null;              // graus 0-360, direção da CÂMERA traseira
let rumoFonte = '';
let rumoEm = 0;               // timestamp da última leitura de orientação
let rumoCru = null;           // sem o offset de calibração
let candAtuais = [];
let filtro = 'todos';
let abertoBarr = null;        // poste aberto no modal
let abertoRank = null;        // posição no ranking quando foi aberto
let rascunho = null;          // { fotoA, fotoD, metaA, metaD, ocup, obs }

/* ---------- 3. Utilidades ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
let toastT = null;
function toast(msg, ms){
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(()=>t.classList.remove('on'), ms||2600);
}
const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const num = (v,d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
function virg(n, dec){ return n==null || !Number.isFinite(n) ? '' : n.toFixed(dec==null?6:dec).replace('.',','); }
function agora(){ const d=new Date(), p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
function seq3(n){ return String(n).padStart(3,'0'); }
function limpaNome(s){ return String(s||'').replace(/[^A-Za-z0-9._-]/g,'_').replace(/_+/g,'_'); }

/* ---------- 4. Geometria ---------- */
const R = 6371008.8, g2r = Math.PI/180;
function distM(a, b){
  const dLat=(b.lat-a.lat)*g2r, dLon=(b.lon-a.lon)*g2r, m=(a.lat+b.lat)/2*g2r;
  const x=dLon*Math.cos(m), y=dLat; return Math.sqrt(x*x+y*y)*R;
}
function azim(a, b){
  const dLon=(b.lon-a.lon)*g2r, m=(a.lat+b.lat)/2*g2r;
  const x=dLon*Math.cos(m), y=(b.lat-a.lat)*g2r;
  let d = Math.atan2(x,y)/g2r; return (d+360)%360;
}
function difAng(a, b){ let d = Math.abs(a-b)%360; return d>180 ? 360-d : d; }
// desloca lat/lon por metros (E, N)
function desloca(lat, lon, dE, dN){
  return { lat: lat + (dN/R)/g2r, lon: lon + (dE/(R*Math.cos(lat*g2r)))/g2r };
}
function posteCoord(p){
  if (!cfg.offE && !cfg.offN) return { lat:p.lat, lon:p.lon };
  return desloca(p.lat, p.lon, cfg.offE, cfg.offN);
}

/* ---------- 5. Sensores ---------- */
function iniciarGps(){
  if (!navigator.geolocation){ $('#pGps').textContent='GPS indisponível'; $('#pGps').className='pill ruim'; return; }
  navigator.geolocation.watchPosition(p => {
    pos = p; pintarGps(); ranquear();
  }, err => {
    const m = err.code===1 ? 'GPS negado' : err.code===3 ? 'GPS sem sinal' : 'GPS erro';
    $('#pGps').textContent = m; $('#pGps').className = 'pill ruim';
  }, { enableHighAccuracy:true, maximumAge:2000, timeout:20000 });
}
function pintarGps(){
  const e = $('#pGps');
  if (!pos){ e.textContent='GPS —'; e.className='pill'; return; }
  const a = pos.coords.accuracy;
  e.textContent = 'GPS ±' + a.toFixed(0) + ' m';
  e.className = 'pill ' + (a<=8 ? 'bom' : a<=20 ? 'medio' : 'ruim');
}
/* Direção para onde a CÂMERA TRASEIRA aponta, a partir da matriz de rotação
   completa (alpha/beta/gamma). Usar só 360-alpha vale apenas com o aparelho
   sem rotação lateral; com o celular inclinado ou deitado o erro chega a 90°. */
function rumoDaCamera(alpha, beta, gamma){
  if (alpha==null || beta==null || gamma==null) return null;
  const d = Math.PI/180;
  const cA=Math.cos(alpha*d), sA=Math.sin(alpha*d);
  const cB=Math.cos(beta*d),  sB=Math.sin(beta*d);
  const cG=Math.cos(gamma*d), sG=Math.sin(gamma*d);
  // vetor -z do aparelho (câmera traseira) levado ao referencial Terra
  const leste = -(cA*sG + sA*sB*cG);
  const norte =  (cA*sB*cG - sA*sG);
  if (Math.hypot(leste, norte) < 0.2) return null;   // aparelho quase deitado
  return (Math.atan2(leste, norte)/d + 360) % 360;
}
/* Direção do TOPO do aparelho — usada quando ele está deitado, para o mapa. */
function rumoDoTopo(alpha, beta, gamma){
  if (alpha==null) return null;
  const d = Math.PI/180;
  const cA=Math.cos(alpha*d), sA=Math.sin(alpha*d);
  const cB=Math.cos((beta||0)*d);
  const leste = -sA*cB, norte = cA*cB;
  if (Math.hypot(leste, norte) < 0.2) return null;
  return (Math.atan2(leste, norte)/d + 360) % 360;
}
function aplicarRumo(h, fonte){
  if (h==null || !Number.isFinite(h)) return;
  rumoCru = (h+360)%360;
  rumo = (rumoCru + (cfg.bussolaOff||0) + 360) % 360;
  rumoFonte = fonte; rumoEm = Date.now();
  const e = $('#pBus');
  e.textContent = 'Bússola ' + rumo.toFixed(0) + '°' + (cfg.bussolaOff ? '*' : '');
  e.className = 'pill bom';
  desenharMapa(); pintarCandidatos();
}
function rumoVelho(){ return rumo!=null && (Date.now()-rumoEm) > 3000; }
function iniciarBussola(){
  const e = $('#pBus');
  const precisaPedir = typeof DeviceOrientationEvent !== 'undefined'
    && typeof DeviceOrientationEvent.requestPermission === 'function';
  const trata = (ev, fonte) => {
    let a = ev.alpha;
    // no iOS o valor confiável é webkitCompassHeading (rumo do topo); converte para alpha
    if (ev.webkitCompassHeading!=null){ a = 360 - ev.webkitCompassHeading; fonte = 'ios'; }
    if (a==null) return;
    const h = rumoDaCamera(a, ev.beta, ev.gamma);
    if (h!=null) return aplicarRumo(h, fonte);
    const t = rumoDoTopo(a, ev.beta, ev.gamma);
    if (t!=null) aplicarRumo(t, fonte+'-topo');
  };
  const liga = () => {
    window.addEventListener('deviceorientationabsolute', ev => trata(ev, 'absolute'), true);
    window.addEventListener('deviceorientation', ev => {
      if (ev.webkitCompassHeading!=null || ev.absolute) trata(ev, 'absolute');
    }, true);
    setTimeout(()=>{ if (rumo==null){ e.textContent='Bússola indisponível'; e.className='pill medio'; } }, 3500);
  };
  // Liga sempre: em boa parte dos Android os eventos chegam sem permissão.
  // O botão fica como reforço para quando o navegador realmente exigir.
  liga();
  if (precisaPedir){
    e.textContent = 'Ativar bússola'; e.className = 'pill medio'; e.style.cursor = 'pointer';
    e.onclick = () => DeviceOrientationEvent.requestPermission()
      .then(r => {
        if (r === 'granted'){ e.onclick = null; e.style.cursor = ''; liga(); }
        else { e.textContent = 'Bússola negada'; e.className = 'pill ruim'; }
      })
      .catch(() => { e.textContent = 'Bússola negada'; e.className = 'pill ruim'; });
  }
}

/* ---------- 6. Ranqueamento ---------- */
function ranquear(){
  if (!postes.length){ return; }
  if (!pos){ $('#candidatos').innerHTML = '<div class="vazio">Aguardando posição do GPS…</div>'; return; }
  const aqui = { lat:pos.coords.latitude, lon:pos.coords.longitude };
  const acc = Math.max(3, pos.coords.accuracy || 10);
  const lista = postes.map(p => {
    const c = posteCoord(p);
    const d = distM(aqui, c);
    const az = azim(aqui, c);
    const dang = rumo==null ? 0 : difAng(az, rumo);
    // A direção até o poste só é confiável quando a distância supera o erro do
    // GPS. Junto ao poste o azimute é ruído puro e não pode penalizar nada.
    const r = 1.5 * acc;
    const peso = d*d / (d*d + r*r);
    const score = d + (rumo==null ? 0 : cfg.k * peso * dang);
    return { p, d, az, dang, peso, score };
  });
  // postes já registrados são rebaixados: o próximo pendente sobe sozinho
  // quando o colaborador termina um poste e segue andando.
  const feito = p => { const r = regs[p.barramento]; return !!(r && r.status !== 'pendente'); };
  const pend = lista.filter(c => !feito(c.p)).sort((a,b) => a.score - b.score);
  const prontos = lista.filter(c => feito(c.p)).sort((a,b) => a.score - b.score);
  candAtuais = pend.slice(0,3);
  // se o poste mais próximo de todos já está registrado, mostra-o ao fim, para revisão
  if (prontos.length && (!pend.length || prontos[0].score < pend[0].score)) candAtuais.push(prontos[0]);
  pintarCandidatos(); desenharMapa();
}
function pintarCandidatos(){
  const el = $('#candidatos');
  if (!candAtuais.length){ el.innerHTML = '<div class="vazio">Sem candidatos.</div>'; return; }
  const avisoRumo = rumo==null
    ? '<div class="aviso" style="margin-bottom:8px">Sem bússola: ordenação apenas por distância. Confira o nº do poste antes de registrar.</div>'
    : rumoVelho()
    ? '<div class="aviso" style="margin-bottom:8px">A bússola parou de atualizar — mexa no aparelho. A leitura abaixo pode estar velha.</div>' : '';
  el.innerHTML = avisoRumo + candAtuais.map((c,i) => {
    const p = c.p, r = regs[p.barramento];
    const feito = r && r.status!=='pendente';
    const pos = feito ? null : (i+1);
    const tags = [];
    if (p.altura) tags.push('<span class="tag">'+esc(p.altura)+'</span>');
    if (p.esforco) tags.push('<span class="tag">'+esc(p.esforco)+'</span>');
    if (p.material) tags.push('<span class="tag">'+esc(p.material)+'</span>');
    if (p.bt) tags.push('<span class="tag bt">BT</span>');
    if (p.mt) tags.push('<span class="tag mt">MT</span>');
    if (p.ocupantes!=null) tags.push('<span class="tag ocup">'+p.ocupantes+' ocup. GEOSWEB</span>');
    if (p.fora_da_os) tags.push('<span class="tag" style="background:#e3f0fb;color:#17476e">fora da OS</span>');
    if (p.irregularidades) tags.push('<span class="tag irr">irregularidade</span>');
    if (p.novo) tags.push('<span class="tag irr">fora da base</span>');
    return '<button class="cand '+(i===0&&!feito?'top':'')+(feito?' feito':'')+'" data-barr="'+esc(p.barramento)+'" data-rank="'+(pos==null?'':pos)+'">'
      + '<div class="cand-l1"><span style="display:flex;align-items:baseline;gap:8px;min-width:0">'
      + '<span class="rank">'+(feito?'✓':pos)+'</span>'
      + '<span style="min-width:0"><span class="barr">'+esc(p.barramento)+'</span>'
      + (p.seq!=null?' <span style="font-size:12px;color:var(--neutro)">ID '+p.seq+'</span>':'')+'</span></span>'
      + '<span class="dist">'+c.d.toFixed(0)+' m</span></div>'
      + '<div class="cand-l2">'+(feito?'<span class="tag" style="background:#dff0e4;color:#14612f">já registrado</span>':'')
      +(rumo==null ? ''
        : c.peso < 0.35
          ? '<span class="tag" style="background:#e3f0fb;color:#17476e">você está junto · rumo ignorado</span>'
          : '<span>desvio '+c.dang.toFixed(0)+'°</span>')
      +tags.join('')+'</div>'
      + '</button>';
  }).join('');
  el.querySelectorAll('.cand').forEach(b => b.onclick = () => abrirCaptura(b.dataset.barr, b.dataset.rank ? Number(b.dataset.rank) : null));
}

/* ---------- 7. Mini-mapa ---------- */
function desenharMapa(){
  const cv = $('#mapa'); if (!cv || !cv.offsetWidth) return;
  const dpr = window.devicePixelRatio||1, W = cv.offsetWidth, H = 190;
  cv.width = W*dpr; cv.height = H*dpr;
  const x = cv.getContext('2d'); x.setTransform(dpr,0,0,dpr,0,0);
  x.clearRect(0,0,W,H); x.fillStyle='#e8edef'; x.fillRect(0,0,W,H);
  const cx = W/2, cy = H/2 + 22, RAIO = 80, esc_ = Math.min(W,H*1.7)/2 - 16;
  // anéis
  x.strokeStyle='#cfd7da'; x.lineWidth=1; x.font='10px sans-serif'; x.fillStyle='#8a969d';
  [20,40,60,80].forEach(m => {
    const r = m/RAIO*esc_;
    x.beginPath(); x.arc(cx,cy,r,0,7); x.stroke();
    if (m%40===0) x.fillText(m+' m', cx+3, cy-r+11);
  });
  if (!pos){ x.fillStyle='#5b6670'; x.font='13px sans-serif'; x.textAlign='center';
    x.fillText('Aguardando GPS…', cx, cy); x.textAlign='left'; return; }
  const aqui = { lat:pos.coords.latitude, lon:pos.coords.longitude };
  // precisão
  const rp = Math.min(pos.coords.accuracy/RAIO*esc_, esc_);
  x.fillStyle='rgba(23,96,74,.10)'; x.beginPath(); x.arc(cx,cy,rp,0,7); x.fill();
  // cone de rumo
  if (rumo!=null){
    const a0=(rumo-22-90)*g2r, a1=(rumo+22-90)*g2r;
    x.fillStyle='rgba(15,61,46,.16)'; x.beginPath(); x.moveTo(cx,cy);
    x.arc(cx,cy,esc_,a0,a1); x.closePath(); x.fill();
  }
  // postes
  const topo = new Set(candAtuais.map(c=>c.p.barramento));
  postes.forEach(p => {
    const c = posteCoord(p), d = distM(aqui,c); if (d>RAIO) return;
    const az = azim(aqui,c), r = d/RAIO*esc_;
    const px = cx + r*Math.sin(az*g2r), py = cy - r*Math.cos(az*g2r);
    const reg = regs[p.barramento], feito = reg && reg.status!=='pendente';
    const idx = candAtuais.findIndex(k=>k.p.barramento===p.barramento);
    x.beginPath(); x.arc(px,py, topo.has(p.barramento)?7:4.5, 0, 7);
    x.fillStyle = feito ? '#1b7f3b' : idx===0 ? '#0f3d2e' : idx>0 ? '#17604a' : '#9aa6ad';
    x.fill();
    if (idx>=0){ x.fillStyle='#fff'; x.font='bold 9px sans-serif'; x.textAlign='center';
      x.fillText(feito?'✓':String(idx+1), px, py+3.2); x.textAlign='left'; }
  });
  // aparelho
  x.fillStyle='#b3261e'; x.beginPath(); x.arc(cx,cy,5,0,7); x.fill();
  if (rumo!=null){
    x.save(); x.translate(cx,cy); x.rotate(rumo*g2r);
    x.fillStyle='#b3261e'; x.beginPath(); x.moveTo(0,-17); x.lineTo(5,-7); x.lineTo(-5,-7); x.closePath(); x.fill();
    x.restore();
  }
  x.fillStyle='#5b6670'; x.font='bold 10px sans-serif'; x.fillText('N', cx-4, 13);
}

/* ---------- 8. Processamento de imagem ---------- */
function carregarImg(file){
  return new Promise((res,rej) => {
    const u = URL.createObjectURL(file), im = new Image();
    im.onload = () => { res(im); };
    im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('imagem inválida')); };
    im.src = u;
  });
}
function nitidez(cv){
  const L = 320, h = Math.max(1, Math.round(cv.height/cv.width*L));
  const t = document.createElement('canvas'); t.width=L; t.height=h;
  const c = t.getContext('2d'); c.drawImage(cv,0,0,L,h);
  const d = c.getImageData(0,0,L,h).data, g = new Float32Array(L*h);
  for (let i=0,j=0;i<d.length;i+=4,j++) g[j] = 0.299*d[i]+0.587*d[i+1]+0.114*d[i+2];
  let s=0, s2=0, n=0;
  for (let y=1;y<h-1;y++) for (let xx=1;xx<L-1;xx++){
    const i=y*L+xx;
    const v = g[i-L]+g[i+L]+g[i-1]+g[i+1]-4*g[i];
    s+=v; s2+=v*v; n++;
  }
  if (!n) return 0;
  const m=s/n; return s2/n - m*m;
}
function tarja(cv, linhas){
  const c = cv.getContext('2d'), W = cv.width;
  const fs = Math.max(13, Math.round(W/52)), pad = Math.round(fs*0.55);
  const alt = linhas.length*(fs+pad*0.42) + pad*1.6;
  const y0 = cv.height - alt;
  c.fillStyle='rgba(8,24,18,.74)'; c.fillRect(0,y0,W,alt);
  c.fillStyle='#fff'; c.textBaseline='top';
  linhas.forEach((t,i) => {
    c.font = (i===0?'bold ':'') + (i===0?fs+2:fs) + 'px -apple-system,Roboto,sans-serif';
    c.fillText(t, pad, y0 + pad*0.8 + i*(fs+pad*0.42));
  });
}
async function processarFoto(file, poste, tipo){
  const im = await carregarImg(file);
  const maxPx = Math.max(600, cfg.maxPx|0);
  const k = Math.min(1, maxPx/Math.max(im.width, im.height));
  const W = Math.round(im.width*k), H = Math.round(im.height*k);
  const cv = document.createElement('canvas'); cv.width=W; cv.height=H;
  const c = cv.getContext('2d'); c.drawImage(im,0,0,W,H);
  URL.revokeObjectURL(im.src);
  const nit = nitidez(cv);
  const meta = {
    tipo, nitidez: Math.round(nit),
    nitido: nit >= cfg.nitidez,
    azimute: rumo==null ? null : Math.round(rumo),
    lat: pos ? pos.coords.latitude : null,
    lon: pos ? pos.coords.longitude : null,
    precisao: pos ? Math.round(pos.coords.accuracy) : null,
    quando: agora(), w:W, h:H
  };
  tarja(cv, [
    (tipo==='A' ? 'FOTO ABERTA' : 'DETALHE DA OCUPAÇÃO') + ' · POSTE ' + poste.barramento,
    'OS ' + (cfg.os||'—') + '  ·  ' + (cfg.projeto||'—') + '  ·  ' + (cfg.municipio||''),
    meta.quando + '   ' + (meta.lat!=null ? meta.lat.toFixed(6)+', '+meta.lon.toFixed(6) : 'sem GPS')
      + (meta.precisao!=null ? '  ±'+meta.precisao+'m' : '')
      + (meta.azimute!=null ? '   azim '+meta.azimute+'°' : '')
  ]);
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', cfg.jpeg));
  return { blob, meta };
}

/* ---------- 9. Captura ---------- */
/* Chave de armazenamento: só o barramento. Estável mesmo quando a inserção de
   um poste no meio da rota renumera o ID_PONTO de todos os seguintes. */
function chaveFoto(p, tipo){ return limpaNome(p.barramento) + '_' + tipo; }
/* Nome na exportação: aí sim com o ID_PONTO, para a pasta sair na ordem da rota. */
function nomeFoto(p, tipo){
  const id = p.seq!=null ? seq3(p.seq) : '000';
  return limpaNome(cfg.os||'SEM-OS') + '_' + id + '_' + limpaNome(p.barramento) + '_' + tipo + '.jpg';
}
function abrirCaptura(barr, rank){
  const p = postes.find(x => x.barramento===barr); if (!p) return;
  abertoBarr = barr; abertoRank = rank || null;
  const r = regs[barr];
  rascunho = {
    fotoA:null, fotoD:null, metaA:null, metaD:null,
    ocup: r && r.ocupantes_campo!=null ? r.ocupantes_campo : (p.ocupantes!=null ? p.ocupantes : 0),
    obs: r ? (r.obs||'') : '',
    jaTemA: !!(r && r.fotoA), jaTemD: !!(r && r.fotoD)
  };
  $('#mTit').textContent = 'Poste ' + barr;
  pintarCaptura(p, r);
  $('#modal').classList.add('on');
}
function pintarCaptura(p, r){
  const cand = candAtuais.find(c => c.p.barramento===p.barramento);
  const temA = rascunho.fotoA || rascunho.jaTemA, temD = rascunho.fotoD || rascunho.jaTemD;
  const ref = p.ocupantes;
  const div = ref!=null && rascunho.ocup!==ref;
  const linhasMeta = [
    ['Nº do poste (barramento)', p.barramento],
    p.novo ? ['Origem', 'NÃO CADASTRADO NO GEOSWEB'] : null,
    p.fora_da_os ? ['Origem', 'EXISTE NA BASE, FORA DA OS'] : null,
    p.novo ? ['Ocupação PRODEPA', p.ocupacao_prodepa ? 'tem' : 'sem'] : null,
    p.novo && p.gps_n ? ['Posição', p.gps_n>1 ? 'média de ' + p.gps_n + ' leituras' : 'leitura única do GPS'] : null,
    p.cod_id ? ['COD_ID BDGD', p.cod_id] : null,
    p.seq!=null ? ['ID no projeto', p.seq] : null,
    cand ? ['Distância', cand.d.toFixed(0)+' m'] : null,
    cand && rumo!=null ? ['Desvio de rumo', cand.dang.toFixed(0)+'°'] : null,
    p.altura ? ['Altura', p.altura] : null,
    p.esforco ? ['Esforço', p.esforco] : null,
    p.material ? ['Material', p.material] : null,
    p.estrutura ? ['Estrutura', p.estrutura] : null,
    (p.bt||p.mt) ? ['Rede', (p.bt?'BT':'')+(p.bt&&p.mt?' + ':'')+(p.mt?'MT':'')] : null,
    p.logradouro ? ['Logradouro', p.logradouro] : null
  ].filter(Boolean);

  $('#mCorpo').innerHTML =
    (p.irregularidades ? '<div class="aviso erro">Irregularidade no GEOSWEB: '+esc(p.irregularidades)+'</div>' : '')
    + '<div class="meta">' + linhasMeta.map(l =>
        '<div><span>'+esc(l[0])+'</span><span>'+esc(l[1])+'</span></div>').join('') + '</div>'

    + '<div class="card"><h2>Fotos obrigatórias (NT.00016)</h2>'
    + slotHtml('A','1 · Foto aberta do poste inteiro', temA, rascunho.metaA, rascunho.jaTemA)
    + slotHtml('D','2 · Detalhe da ocupação', temD, rascunho.metaD, rascunho.jaTemD)
    + '</div>'

    + '<div class="card"><h2>Ocupantes conferidos em campo</h2>'
    + '<div class="contador"><button id="oMenos">−</button><output id="oVal">'+rascunho.ocup+'</output><button id="oMais">+</button></div>'
    + (ref!=null
        ? '<div class="ref '+(div?'diverge':'confere')+'" id="oRef">'
          + (div ? 'Divergente — GEOSWEB declara '+ref+' ocupante(s), campo aponta '+rascunho.ocup
                 : 'Confere com o GEOSWEB ('+ref+')') + '</div>'
        : '<div class="ref">Sem referência de ocupantes no pacote de campo.</div>')
    + '<label for="oObs">Observação (opcional)</label>'
    + '<textarea id="oObs" placeholder="Ex.: poste substituído, cabo em outro lado da via, acesso obstruído…">'+esc(rascunho.obs)+'</textarea>'
    + '</div>'

    + (cand && rumo!=null && cand.d >= 20
        ? '<button class="btn sec" id="btnCalib" style="margin-bottom:10px">Estou apontando para este poste — calibrar bússola</button>'
        : '')
    + '<button class="btn" id="btnConfirmar" '+(temA&&temD?'':'disabled')+'>'
    + (temA&&temD ? 'Confirmar registro e seguir' : 'Faltam as duas fotos') + '</button>'
    + '<div class="linha-btn">'
    + '<button class="btn sec pequeno" id="btnDescartar" style="flex:1">Descartar do projeto</button>'
    + (r && r.status!=='pendente' ? '<button class="btn perigo pequeno" id="btnApagarReg" style="flex:1">Apagar registro</button>' : '')
    + '</div>';

  $('#mCorpo').querySelectorAll('[data-slot]').forEach(b => b.onclick = () => {
    const t = b.dataset.slot; (t==='A' ? $('#camA') : $('#camD')).click();
  });
  $('#oMenos').onclick = () => { rascunho.ocup = Math.max(0, rascunho.ocup-1); atualizarOcup(p); };
  $('#oMais').onclick  = () => { rascunho.ocup = Math.min(99, rascunho.ocup+1); atualizarOcup(p); };
  $('#oObs').oninput = e => rascunho.obs = e.target.value;
  const cb = $('#btnCalib');
  if (cb) cb.onclick = async () => {
    const c2 = candAtuais.find(x => x.p.barramento===p.barramento);
    if (!c2 || rumoCru==null) return toast('Sem leitura de bússola agora');
    let off = ((c2.az - rumoCru + 540) % 360) - 180;   // -180..180
    cfg.bussolaOff = Math.round(off);
    await kvSet('cfg', cfg);
    rumo = (rumoCru + cfg.bussolaOff + 360) % 360;
    toast('Bússola calibrada: ' + (off>0?'+':'') + Math.round(off) + '°', 3500);
    ranquear(); pintarCaptura(p, regs[p.barramento]);
  };
  $('#btnConfirmar').onclick = () => salvarRegistro(p, 'auto');
  $('#btnDescartar').onclick = () => abrirDescarte(p);
  const ap = $('#btnApagarReg'); if (ap) ap.onclick = () => apagarRegistro(p.barramento);
}
function slotHtml(t, rot, tem, meta, era){
  const m = meta;
  return '<div class="foto-slot '+(tem?'tem':'')+'">'
    + (tem && m && m.url ? '<img src="'+m.url+'" alt="">' : '<div style="width:72px;height:72px;border-radius:7px;background:#e3e7e9;display:flex;align-items:center;justify-content:center;font-size:24px;flex:none">📷</div>')
    + '<div class="foto-info"><b>'+rot+'</b>'
    + (tem
        ? (m ? '<span class="'+(m.nitido?'nitido':'borrado')+'">'+(m.nitido?'Nítida':'ATENÇÃO: possivelmente borrada')+'</span> · nitidez '+m.nitidez
               + (m.azimute!=null?' · azim '+m.azimute+'°':'')
           : (era ? 'Já registrada' : 'Pronta'))
        : 'Toque para fotografar')
    + '</div>'
    + '<button class="btn sec pequeno" data-slot="'+t+'" style="flex:none">'+(tem?'Refazer':'Tirar')+'</button>'
    + '</div>';
}
function atualizarOcup(p){
  $('#oVal').textContent = rascunho.ocup;
  const ref = p.ocupantes, el = $('#oRef'); if (!el || ref==null) return;
  const div = rascunho.ocup !== ref;
  el.className = 'ref ' + (div?'diverge':'confere');
  el.textContent = div ? 'Divergente — GEOSWEB declara '+ref+' ocupante(s), campo aponta '+rascunho.ocup
                       : 'Confere com o GEOSWEB ('+ref+')';
}
async function receberFoto(input, tipo){
  const f = input.files && input.files[0]; input.value = '';
  if (!f || !abertoBarr) return;
  const p = postes.find(x => x.barramento===abertoBarr); if (!p) return;
  toast('Processando foto…', 1400);
  try{
    const { blob, meta } = await processarFoto(f, p, tipo);
    meta.url = URL.createObjectURL(blob);
    meta.nome = chaveFoto(p, tipo);
    meta.bytes = blob.size;
    if (tipo==='A'){ rascunho.fotoA = blob; rascunho.metaA = meta; }
    else { rascunho.fotoD = blob; rascunho.metaD = meta; }
    pintarCaptura(p, regs[p.barramento]);
    if (!meta.nitido) toast('Foto parece borrada — considere refazer', 3600);
  }catch(e){ console.error(e); toast('Não foi possível ler a foto'); }
}
async function salvarRegistro(p, modo, motivo){
  const b = p.barramento;
  const ant = regs[b] || {};
  const desc = modo === 'descartado';
  const reg = {
    barramento: b, seq: p.seq, cod_id: p.cod_id||'',
    status: desc ? 'descartado'
          : (p.ocupantes!=null && rascunho && rascunho.ocup!==p.ocupantes ? 'divergente' : 'ok'),
    motivo: desc ? (motivo||'') : '',
    ocupantes_campo: desc || !rascunho ? null : rascunho.ocup,
    ocupantes_geosweb: p.ocupantes!=null ? p.ocupantes : null,
    obs: (rascunho && rascunho.obs) || '',
    ranking: abertoRank, ranking_busca: abertoRank==null,
    dist_m: null, desvio_rumo: null, rumo_fonte: rumoFonte,
    gps_lat: pos?pos.coords.latitude:null, gps_lon: pos?pos.coords.longitude:null,
    gps_precisao: pos?Math.round(pos.coords.accuracy):null,
    quando: agora(),
    fotoA: ant.fotoA||null, fotoD: ant.fotoD||null,
    metaA: ant.metaA||null, metaD: ant.metaD||null
  };
  const cand = candAtuais.find(c => c.p.barramento===b);
  if (cand){ reg.dist_m = Math.round(cand.d*10)/10; reg.desvio_rumo = rumo==null?null:Math.round(cand.dang); }
  if (rascunho && rascunho.fotoA){ reg.fotoA = chaveFoto(p,'A'); await fotoSet(reg.fotoA, rascunho.fotoA);
    reg.metaA = { nitidez:rascunho.metaA.nitidez, nitido:rascunho.metaA.nitido, azimute:rascunho.metaA.azimute,
                  lat:rascunho.metaA.lat, lon:rascunho.metaA.lon, precisao:rascunho.metaA.precisao,
                  quando:rascunho.metaA.quando, bytes:rascunho.metaA.bytes }; }
  if (rascunho && rascunho.fotoD){ reg.fotoD = chaveFoto(p,'D'); await fotoSet(reg.fotoD, rascunho.fotoD);
    reg.metaD = { nitidez:rascunho.metaD.nitidez, nitido:rascunho.metaD.nitido, azimute:rascunho.metaD.azimute,
                  lat:rascunho.metaD.lat, lon:rascunho.metaD.lon, precisao:rascunho.metaD.precisao,
                  quando:rascunho.metaD.quando, bytes:rascunho.metaD.bytes }; }
  regs[b] = reg;
  await kvSet('regs', regs);
  fecharModal();
  toast(desc ? 'Poste descartado — vai para a lista de desmarcar no GEOSWEB'
        : reg.status==='divergente' ? 'Registrado com divergência de ocupantes' : 'Registro concluído');
  ranquear(); pintarLista(); pintarProgresso(); pintarExport();
}
async function apagarRegistro(b){
  if (!confirm('Apagar o registro deste poste, inclusive as fotos?')) return;
  delete regs[b]; await kvSet('regs', regs);
  fecharModal(); ranquear(); pintarLista(); pintarProgresso(); pintarExport(); toast('Registro apagado');
}
function fecharModal(){ $('#modal').classList.remove('on'); abertoBarr=null; abertoRank=null; rascunho=null; }

/* ---------- 10. Busca manual ---------- */
/* Poste que existe em campo e não está no GEOSWEB. Não recebe ID_PONTO:
   a numeração da rota pertence ao pipeline do dossiê. Fica marcado como NOVO
   e ancorado "após" o poste da base mais próximo, para o projetista decidir. */
let mediaPos = null;
let novoPdp = false;
function abrirNovoPoste(){
  if (!pos) return toast('Aguardando o GPS');
  abertoBarr = null; abertoRank = null;
  mediaPos = { soma_lat:0, soma_lon:0, peso:0, n:0 };
  const perto = maisProximo();
  $('#mTit').textContent = 'Poste fora da base';
  $('#mCorpo').innerHTML =
      '<div class="aviso">Use isto só para poste que <b>existe em campo e não consta do GEOSWEB</b>. '
    + 'Ele não entra na numeração da rota — fica marcado para o projetista resolver o cadastro.</div>'
    + '<label>Nº do poste (ANEXO B: a própria coordenada)</label>'
    + '<div class="card" style="margin:0 0 10px"><b id="nBarr" class="barr" style="font-size:15px"></b></div>'
    + '<label>Posição</label>'
    + '<div class="card" style="margin:0 0 10px"><div id="nPos" class="mini"></div>'
    + '<button class="btn sec pequeno" id="nMedir" style="margin-top:8px;width:100%">Melhorar posição (10 s parado)</button></div>'
    + '<label>Onde ele entra na rota</label>'
    + '<div class="mini" id="nApos">'+(perto ? 'Logo após <b>'+esc(perto.p.barramento)+'</b> ('+perto.d.toFixed(0)+' m)' : 'Sem poste da base por perto')+'</div>'
    + '<label>Ocupação da PRODEPA neste poste</label>'
    + '<div class="linha-btn" style="margin-bottom:4px">'
    + '<button class="btn sec pequeno" id="nPdpSim" style="flex:1">Tem</button>'
    + '<button class="btn pequeno" id="nPdpNao" style="flex:1">Não tem</button></div>'
    + '<label for="nOcup">Ocupantes contados em campo</label>'
    + '<input type="number" id="nOcup" value="0" min="0" max="99" inputmode="numeric">'
    + '<label for="nObs">Observação</label>'
    + '<textarea id="nObs" placeholder="Ex.: poste de concreto novo, sem plaqueta, entre os postes X e Y"></textarea>'
    + '<button class="btn" id="nCriar" style="margin-top:12px">Criar e fotografar</button>';
  $('#modal').classList.add('on');
  pintarPosNovo();
  novoPdp = false;
  const marca = () => {
    $('#nPdpSim').className = 'btn pequeno' + (novoPdp ? '' : ' sec');
    $('#nPdpNao').className = 'btn pequeno' + (novoPdp ? ' sec' : '');
  };
  $('#nPdpSim').onclick = () => { novoPdp = true; marca(); };
  $('#nPdpNao').onclick = () => { novoPdp = false; marca(); };
  marca();
  $('#nMedir').onclick = medirPosicao;
  $('#nCriar').onclick = criarNovoPoste;
}
/* ID_PONTO = ordem do inventário. Renumera 1..n depois de uma inserção. */
function renumerar(){ let n = 0; postes.forEach(p => { p.seq = p.fora_da_os ? null : ++n; }); }
function maisProximo(){
  if (!pos || !postes.length) return null;
  const aqui = { lat:pos.coords.latitude, lon:pos.coords.longitude };
  let m = null;
  postes.filter(p=>!p.novo).forEach(p => {
    const d = distM(aqui, posteCoord(p));
    if (!m || d < m.d) m = { p, d };
  });
  return m;
}
/* Regra do ANEXO B: no poste não cadastrado o "Nº do Poste" é a própria
   coordenada decimal, no formato "lat, long". */
function barramentoCoord(lat, lon){ return lat.toFixed(7) + ', ' + lon.toFixed(7); }
function posNovo(){
  if (mediaPos && mediaPos.peso > 0)
    return { lat: mediaPos.soma_lat/mediaPos.peso, lon: mediaPos.soma_lon/mediaPos.peso, n: mediaPos.n };
  return pos ? { lat:pos.coords.latitude, lon:pos.coords.longitude, n:1 } : null;
}
function pintarPosNovo(){
  const e = $('#nPos'); if (!e) return;
  const p = posNovo();
  const nb = $('#nBarr');
  if (nb && p) nb.textContent = barramentoCoord(p.lat, p.lon);
  e.innerHTML = p ? p.lat.toFixed(6)+', '+p.lon.toFixed(6)
      + ' · ±'+(pos?Math.round(pos.coords.accuracy):'?')+' m'
      + (p.n>1 ? ' · <b>média de '+p.n+' leituras</b>' : ' · leitura única') : 'sem GPS';
}
function medirPosicao(){
  const b = $('#nMedir'); if (!b) return;
  mediaPos = { soma_lat:0, soma_lon:0, peso:0, n:0 };
  let resta = 10;
  b.disabled = true;
  const t = setInterval(() => {
    if (pos){
      const w = 1/Math.max(1, Math.pow(pos.coords.accuracy||10, 2));
      mediaPos.soma_lat += pos.coords.latitude*w;
      mediaPos.soma_lon += pos.coords.longitude*w;
      mediaPos.peso += w; mediaPos.n++;
    }
    resta--; b.textContent = 'Medindo… ' + resta + ' s';
    pintarPosNovo();
    if (resta<=0){ clearInterval(t); b.disabled=false; b.textContent='Melhorar posição (10 s parado)';
      toast('Posição medida com '+mediaPos.n+' leituras'); }
  }, 1000);
}
async function criarNovoPoste(){
  const p0 = posNovo(); if (!p0) return toast('Sem GPS');
  const barr = barramentoCoord(p0.lat, p0.lon);
  if (postes.some(x => String(x.barramento) === barr))
    return toast('Já existe um poste nessa coordenada');
  const perto = maisProximo();
  const novo = {
    seq: null, barramento: barr, cod_id: '',
    lat: p0.lat, lon: p0.lon,
    altura:'', esforco:'', material:'', estrutura:'', bt:false, mt:false,
    ocupantes: null, irregularidades:'', logradouro:'',
    novo: true, origem: 'campo', ocupacao_prodepa: novoPdp,
    apos: perto ? perto.p.barramento : '',
    gps_n: p0.n, gps_precisao: pos ? Math.round(pos.coords.accuracy) : null,
    criado_em: agora()
  };
  // entra NA sequência, logo após a âncora, e todos são renumerados:
  // o ID_PONTO é a ordem do inventário, e o ANEXO A lista os dois tipos juntos.
  const i = perto ? postes.findIndex(x => x.barramento === perto.p.barramento) : -1;
  if (i >= 0) postes.splice(i+1, 0, novo); else postes.push(novo);
  renumerar();
  await kvSet('postes', postes);
  const oc = parseInt($('#nOcup').value, 10) || 0;
  const obs = $('#nObs').value || '';
  pintarBase(); pintarLista(); pintarProgresso(); ranquear();
  abrirCaptura(barr, null);
  rascunho.ocup = oc; rascunho.obs = obs;
  pintarCaptura(novo, null);
  toast('Poste criado — agora as duas fotos');
}
/* Descartar é diferente de ainda não ter visitado. Só o descarte explícito
   vira "desmarcar no GEOSWEB"; poste pendente significa inventário incompleto. */
const MOTIVOS = [
  ['trocado',        'Troquei por outro poste',      'a rota passou a usar outro poste, em geral do outro lado da via'],
  ['nao_encontrado', 'Não existe em campo',          'o poste da base não foi encontrado no local'],
  ['inacessivel',    'Inacessível ou inviável',      'existe, mas não dá para usar: obstruído, em obra, risco'],
  ['sobra',          'Selecionado a mais',           'entrou na seleção por precaução e a rota não precisou dele']
];
function abrirDescarte(p){
  $('#mTit').textContent = 'Descartar ' + p.barramento;
  $('#mCorpo').innerHTML =
      '<div class="aviso">Isto marca o poste para <b>desmarcar no GEOSWEB</b>. Use só quando a decisão estiver tomada — poste ainda não visitado deve ficar pendente.</div>'
    + MOTIVOS.map(m => '<button class="btn sec" data-m="'+m[0]+'" style="margin-bottom:8px;text-align:left;justify-content:flex-start">'
        + '<span><b>'+m[1]+'</b><br><span style="font-weight:400;font-size:12px;color:var(--neutro)">'+m[2]+'</span></span></button>').join('')
    + '<button class="btn sec pequeno" id="dVoltar" style="margin-top:6px">Voltar</button>';
  $('#mCorpo').querySelectorAll('[data-m]').forEach(b => b.onclick = () => salvarRegistro(p, 'descartado', b.dataset.m));
  $('#dVoltar').onclick = () => abrirCaptura(p.barramento, abertoRank);
}
function abrirBusca(){
  abertoBarr=null; abertoRank=null;
  $('#mTit').textContent = 'Buscar poste';
  $('#mCorpo').innerHTML = '<label for="qBusca">Nº do poste (barramento) ou ID do projeto</label>'
    + '<input type="text" id="qBusca" placeholder="C42433611 ou 17" autocomplete="off">'
    + '<div id="qRes" style="margin-top:12px"></div>';
  $('#modal').classList.add('on');
  const inp = $('#qBusca');
  const busca = () => {
    const q = inp.value.trim().toUpperCase();
    const res = !q ? [] : postes.filter(p =>
      String(p.barramento).toUpperCase().includes(q) || String(p.seq)===q).slice(0,25);
    $('#qRes').innerHTML = !q ? '<div class="vazio">Digite para buscar.</div>'
      : !res.length ? '<div class="vazio">Nenhum poste encontrado.</div>'
      : res.map(p => itemHtml(p)).join('');
    $('#qRes').querySelectorAll('.item').forEach(b => b.onclick = () => abrirCaptura(b.dataset.barr, null));
  };
  inp.oninput = busca; busca(); setTimeout(()=>inp.focus(), 120);
}

/* ---------- 11. Lista de postes ---------- */
function itemHtml(p){
  const r = regs[p.barramento], st = r ? r.status : 'pendente';
  const cls = st==='ok'?'ok':st==='divergente'?'div':st==='descartado'?'nao':'';
  const mot = (MOTIVOS.find(m=>m[0]===(r&&r.motivo))||[])[1];
  const txt = st==='ok'?'Concluído':st==='divergente'?'Divergente'
            : st==='descartado'?('Descartado'+(mot?' · '+mot.toLowerCase():'')):'Pendente';
  return '<button class="item" data-barr="'+esc(p.barramento)+'">'
    + '<span class="bolinha '+cls+'"></span>'
    + '<span style="flex:1;min-width:0">'
    + '<span class="barr" style="font-size:15px">'+esc(p.barramento)+'</span>'
    + (p.seq!=null?' <span style="font-size:11.5px;color:var(--neutro)">ID '+p.seq+'</span>':'')
    + '<br><span style="font-size:12px;color:var(--neutro)">'+txt
    + (r && r.ocupantes_campo!=null ? ' · '+r.ocupantes_campo+' ocup.' : '')
    + (p.ocupantes!=null ? ' (GEOSWEB '+p.ocupantes+')' : '')
    + (r && r.ranking ? ' · ranking '+r.ranking : (r && r.ranking_busca ? ' · busca manual' : ''))
    + '</span></span>'
    + '<span style="color:var(--neutro);font-size:20px">›</span></button>';
}
function pintarLista(){
  const el = $('#listaPostes');
  if (!postes.length){ el.innerHTML = '<div class="vazio">Nenhum poste no pacote de campo.</div>'; return; }
  const f = postes.filter(p => {
    const st = regs[p.barramento] ? regs[p.barramento].status : 'pendente';
    return filtro==='todos' || filtro===st;
  });
  el.innerHTML = !f.length ? '<div class="vazio">Nada neste filtro.</div>' : f.map(itemHtml).join('');
  el.querySelectorAll('.item').forEach(b => b.onclick = () => abrirCaptura(b.dataset.barr, null));
}
function pintarProgresso(){
  const t = postes.filter(p => !p.fora_da_os).length;
  const f = Object.values(regs).filter(r => r.status!=='pendente').length;
  $('#pProg').textContent = f + '/' + t;
  $('#pProg').className = 'pill ' + (t&&f===t ? 'bom' : f ? 'medio' : '');
  $('#hdrOs').textContent = cfg.os ? 'OS ' + cfg.os : (cfg.projeto || '—');
}

/* ---------- 12. Importação ---------- */
const SEMACENTO = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
const MAPA = {
  seq:['id','id_ponto','idponto','seq','sequencia','ordem','ponto','n','no','num'],
  barramento:['barramento','poste','no do poste','n do poste','numero do poste','codigo','cod_poste','elemento','barra'],
  cod_id:['cod_id','codid','cod_id_bdgd','cod id','codigo_bdgd'],
  lat:['latitude','lat','y','coord_y'],
  lon:['longitude','long','lon','x','coord_x'],
  altura:['altura','alt','alt_m','altura_m','altura (m)'],
  esforco:['esforco','esf','esforco_dan','esforco (dan)'],
  material:['material','mat'],
  estrutura:['estrutura','pos','tipo_estrutura','tipo'],
  bt:['bt','tem_bt','rede_bt','bt_presente'],
  mt:['mt','tem_mt','rede_mt','mt_presente'],
  ocupantes:['ocupantes','quantidade de ocupantes','qtd_ocupantes','qtde_ocupantes','n_ocupantes','ocup','qtd ocupantes'],
  irregularidades:['irregularidades','irregularidade','irreg'],
  logradouro:['logradouro','endereco','rua','via','nome_logradouro']
};
function acharCol(cabec){
  const n = cabec.map(SEMACENTO), r = {};
  for (const [campo, alvos] of Object.entries(MAPA)){
    let i = n.findIndex(c => alvos.includes(c));
    if (i<0) i = n.findIndex(c => alvos.some(a => c.includes(a) && Math.abs(c.length-a.length)<=4));
    if (i>=0) r[campo] = i;
  }
  return r;
}
/* corrige coordenada estragada pelo Excel: "-24.215.556" -> -2,4215556 ; "-2,42" -> -2.42 */
function coord(txt, tipo){
  if (txt==null) return null;
  let s = String(txt).trim(); if (!s) return null;
  const neg = /^-/.test(s);
  s = s.replace(/[^\d.,]/g,'');
  const faixa = tipo==='lat' ? [-10.5, 3.0] : [-61.0, -44.0];
  const dentro = v => v>=faixa[0] && v<=faixa[1];
  // caminho normal
  let v = parseFloat(s.indexOf(',')>=0 && s.indexOf('.')<0 ? s.replace(',','.')
          : (s.match(/\./g)||[]).length<=1 ? s : s);
  if (Number.isFinite(v)){ const w = neg?-v:v; if (dentro(w)) return w; }
  // reconstrução: só os dígitos, testando onde cai o separador
  const d = s.replace(/[.,]/g,'');
  for (let k=1; k<=2 && k<d.length; k++){
    const w0 = parseFloat(d.slice(0,k) + '.' + d.slice(k));
    const w = neg ? -w0 : w0;
    if (dentro(w)) return w;
  }
  return Number.isFinite(v) ? (neg?-v:v) : null;
}
function boolish(v){
  const s = SEMACENTO(v); if (!s) return false;
  return ['1','s','sim','true','v','verdadeiro','x','y','yes'].includes(s) || Number(s)>0;
}
function dividirLinha(l, sep){
  const out=[]; let cur='', dentro=false;
  for (let i=0;i<l.length;i++){
    const c=l[i];
    if (c==='"'){ if (dentro && l[i+1]==='"'){ cur+='"'; i++; } else dentro=!dentro; }
    else if (c===sep && !dentro){ out.push(cur); cur=''; }
    else cur+=c;
  }
  out.push(cur); return out.map(s=>s.trim());
}
function lerCsv(txt){
  txt = txt.replace(/^﻿/,'');
  const linhas = txt.split(/\r?\n/).filter(l => l.trim());
  if (linhas.length<2) throw new Error('CSV sem dados');
  const sep = (linhas[0].match(/;/g)||[]).length >= (linhas[0].match(/,/g)||[]).length ? ';' : ',';
  const cab = dividirLinha(linhas[0], sep);
  const col = acharCol(cab);
  if (col.lat==null || col.lon==null) throw new Error('Não achei colunas de latitude/longitude. Cabeçalho lido: ' + cab.join(' | '));
  const out = [];
  for (let i=1;i<linhas.length;i++){
    const c = dividirLinha(linhas[i], sep);
    const g = k => col[k]!=null ? c[col[k]] : null;
    const lat = coord(g('lat'),'lat'), lon = coord(g('lon'),'lon');
    if (lat==null || lon==null) continue;
    const barr = (g('barramento')||g('cod_id')||'').trim() || ('P'+(i));
    const oc = g('ocupantes');
    out.push({
      seq: col.seq!=null && c[col.seq] ? (parseInt(String(c[col.seq]).replace(/\D/g,''),10) || i) : i,
      barramento: barr, cod_id: (g('cod_id')||'').trim(),
      lat, lon,
      altura: (g('altura')||'').trim(), esforco: (g('esforco')||'').trim(),
      material: (g('material')||'').trim(), estrutura: (g('estrutura')||'').trim(),
      bt: boolish(g('bt')), mt: boolish(g('mt')),
      ocupantes: oc!=null && String(oc).trim()!=='' ? (parseInt(String(oc).replace(/\D/g,''),10) || 0) : null,
      irregularidades: (g('irregularidades')||'').trim(),
      logradouro: (g('logradouro')||'').trim()
    });
  }
  if (!out.length) throw new Error('Nenhuma linha com coordenada válida');
  return out;
}
function lerKml(txt){
  const doc = new DOMParser().parseFromString(txt, 'application/xml');
  const pms = Array.from(doc.getElementsByTagName('Placemark'));
  const out = [];
  pms.forEach((pm, i) => {
    const pt = pm.getElementsByTagName('Point')[0]; if (!pt) return;
    const co = pt.getElementsByTagName('coordinates')[0]; if (!co) return;
    const partes = co.textContent.trim().split(/[,\s]+/);
    const lon = parseFloat(partes[0]), lat = parseFloat(partes[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const nome = (pm.getElementsByTagName('name')[0]||{}).textContent || ('P'+(i+1));
    const ext = {};
    Array.from(pm.getElementsByTagName('Data')).forEach(d => {
      const k = SEMACENTO(d.getAttribute('name'));
      const v = (d.getElementsByTagName('value')[0]||{}).textContent;
      if (k) ext[k] = (v||'').trim();
    });
    Array.from(pm.getElementsByTagName('SimpleData')).forEach(d => {
      const k = SEMACENTO(d.getAttribute('name')); if (k) ext[k] = (d.textContent||'').trim();
    });
    const pega = alvos => { for (const a of alvos) if (ext[a]!=null && ext[a]!=='') return ext[a];
      for (const k of Object.keys(ext)) if (alvos.some(a=>k.includes(a)) && ext[k]!=='') return ext[k]; return ''; };
    const oc = pega(MAPA.ocupantes);
    out.push({
      seq: i+1,
      barramento: (pega(MAPA.barramento) || nome.trim()),
      cod_id: pega(MAPA.cod_id), lat, lon,
      altura: pega(MAPA.altura), esforco: pega(MAPA.esforco),
      material: pega(MAPA.material), estrutura: pega(MAPA.estrutura),
      bt: boolish(pega(MAPA.bt)), mt: boolish(pega(MAPA.mt)),
      ocupantes: oc!=='' ? (parseInt(String(oc).replace(/\D/g,''),10)||0) : null,
      irregularidades: pega(MAPA.irregularidades), logradouro: pega(MAPA.logradouro)
    });
  });
  if (!out.length) throw new Error('Nenhum ponto (Placemark/Point) no KML');
  return out;
}
/* Pacote gerado pelo Painel do Projetista: traz os postes da OS já ordenados
   e o cinturão da BDGD, que são as alternativas para troca de lado de via. */
function lerPacote(d){
  const arr = Array.isArray(d) ? d : (d && Array.isArray(d.postes) ? d.postes : null);
  if (!arr) throw new Error('JSON válido, mas sem a lista de postes. '
    + 'Use o arquivo _PACOTE.json gerado pelo painel.');
  return arr.map((p, i) => ({
    seq: p.seq!=null ? p.seq : null,
    barramento: p.barramento || ('BDGD-' + (p.cod_id || i)),
    cod_id: p.cod_id || '',
    lat: p.lat, lon: p.lon,
    altura: p.altura || '', esforco: p.esforco || '',
    material: p.material || '', estrutura: p.estrutura || '',
    bt: !!p.bt, mt: !!p.mt,
    ocupantes: p.ocupantes!=null ? p.ocupantes : null,
    irregularidades: p.irregularidades || '',
    logradouro: p.logradouro || '',
    ocupacao_prodepa: !!p.ocupacao_prodepa,
    origem: p.origem || 'GEOSWEB',
    fora_da_os: p.origem === 'BDGD_FORA_DA_OS'
  })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}
async function importarArquivo(file){
  let txt = await file.text();
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);     // BOM
  txt = txt.trim();
  if (!txt) throw new Error('O arquivo chegou vazio. Reenvie — o WhatsApp às vezes trunca.');
  const ehJson = /^[\{\[]/.test(txt) || /\.json$/i.test(file.name);
  if (ehJson){
    let d;
    try { d = JSON.parse(txt); }
    catch(e){ throw new Error('O arquivo não é um JSON válido (' + e.message + '). '
      + 'Se veio por aplicativo de mensagem, baixe de novo sem abrir em editor.'); }
    postes = lerPacote(d);
    if (d.os || d.projeto || d.municipio){
      cfg.os = d.os || cfg.os; cfg.projeto = d.projeto || cfg.projeto;
      cfg.municipio = d.municipio || cfg.municipio;
      await kvSet('cfg', cfg); pintarCfg();
    }
    await kvSet('postes', postes);
    pintarBase(); pintarLista(); pintarProgresso(); pintarExport(); ranquear();
    $('#semBase').classList.add('oculto'); $('#blocoCampo').classList.remove('oculto');
    const nOs = postes.filter(p=>!p.fora_da_os).length;
    toast(nOs + ' postes da OS + ' + (postes.length-nOs) + ' do cinturão', 4000);
    setTimeout(desenharMapa, 80);
    return;
  }
  const kml = /\.kml$|\.xml$/i.test(file.name) || /<kml/i.test(txt.slice(0,900));
  let novos = kml ? lerKml(txt) : lerCsv(txt);
  // dedupe por barramento, mantendo o primeiro
  const vistos = new Set(); novos = novos.filter(p => {
    const k = String(p.barramento).toUpperCase();
    if (vistos.has(k)) return false; vistos.add(k); return true;
  });
  postes = novos;
  await kvSet('postes', postes);
  pintarBase(); pintarLista(); pintarProgresso(); pintarExport(); ranquear();
  $('#semBase').classList.add('oculto'); $('#blocoCampo').classList.remove('oculto');
  toast(postes.length + ' postes carregados');
  setTimeout(desenharMapa, 80);
}
function pacoteDemo(){
  // corredor sintético para teste de caminhada (DEMONSTRAÇÃO — não é dado da Equatorial).
  // Nasce em volta da posição atual, para o teste funcionar em qualquer lugar;
  // sem GPS ainda, cai num ponto de Belém.
  const base = pos
    ? desloca(pos.coords.latitude, pos.coords.longitude, -40, 0)
    : { lat:-1.45215, lon:-48.49015 };
  const out = [];
  for (let i=0;i<14;i++){
    const lado = i%2 ? 1 : -1;
    const d = desloca(base.lat, base.lon, i*36 + (i%3), lado*7);
    out.push({
      seq:i+1, barramento:'C'+(42433600+i*7), cod_id:String(107945700+i*13),
      lat:d.lat, lon:d.lon,
      altura: ['11 m','12 m','10,5 m','9 m'][i%4], esforco: ['300 daN','600 daN','150 daN','400 daN'][i%4],
      material: i%9===3 ? 'Em compósito' : 'Concreto', estrutura: i%2 ? 'Duplo T' : 'Circular',
      bt: i%4!==2, mt: i%3!==1,
      ocupantes: [1,2,3,0,2,1][i%6],
      irregularidades: i===5 ? 'Cabo sem identificação' : (i===9 ? 'Altura de via irregular' : ''),
      logradouro: 'Via de demonstração'
    });
  }
  return out;
}
function pintarBase(){
  const el = $('#infoBase');
  if (!postes.length){ el.innerHTML = 'Nenhum pacote carregado.'; return; }
  const comOc = postes.filter(p=>p.ocupantes!=null).length;
  const comIrr = postes.filter(p=>p.irregularidades).length;
  const comAtr = postes.filter(p=>p.altura||p.esforco).length;
  el.innerHTML = '<b>'+postes.length+' postes</b> · '+comOc+' com ocupantes do GEOSWEB · '
    + comAtr+' com atributos da BDGD · '+comIrr+' com irregularidade apontada';
}

/* ---------- 13. ZIP (store, sem compressão) ---------- */
const CRCT = (() => { const t = new Uint32Array(256);
  for (let n=0;n<256;n++){ let c=n; for (let k=0;k<8;k++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1; t[n]=c>>>0; }
  return t; })();
function crc32(u8){ let c = 0xFFFFFFFF;
  for (let i=0;i<u8.length;i++) c = CRCT[(c^u8[i])&0xFF] ^ (c>>>8);
  return (c^0xFFFFFFFF)>>>0; }
function dosData(d){
  return { t: ((d.getHours()&31)<<11) | ((d.getMinutes()&63)<<5) | ((d.getSeconds()/2)&31),
           d: (((d.getFullYear()-1980)&127)<<9) | (((d.getMonth()+1)&15)<<5) | (d.getDate()&31) };
}
function zip(arquivos){ // [{nome, dados:Uint8Array}]
  const enc = new TextEncoder(), dt = dosData(new Date());
  const locais = [], centrais = []; let off = 0;
  arquivos.forEach(a => {
    const nome = enc.encode(a.nome), crc = crc32(a.dados), tam = a.dados.length;
    const lh = new Uint8Array(30 + nome.length), v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
    v.setUint16(8, 0, true); v.setUint16(10, dt.t, true); v.setUint16(12, dt.d, true);
    v.setUint32(14, crc, true); v.setUint32(18, tam, true); v.setUint32(22, tam, true);
    v.setUint16(26, nome.length, true); v.setUint16(28, 0, true); lh.set(nome, 30);
    locais.push(lh, a.dados);
    const ch = new Uint8Array(46 + nome.length), w = new DataView(ch.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true);
    w.setUint16(8, 0x0800, true); w.setUint16(10, 0, true);
    w.setUint16(12, dt.t, true); w.setUint16(14, dt.d, true);
    w.setUint32(16, crc, true); w.setUint32(20, tam, true); w.setUint32(24, tam, true);
    w.setUint16(28, nome.length, true); w.setUint16(30, 0, true); w.setUint16(32, 0, true);
    w.setUint16(34, 0, true); w.setUint16(36, 0, true); w.setUint32(38, 0, true);
    w.setUint32(42, off, true); ch.set(nome, 46);
    centrais.push(ch);
    off += lh.length + tam;
  });
  const cdTam = centrais.reduce((s,c)=>s+c.length, 0);
  const eo = new Uint8Array(22), e = new DataView(eo.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(4,0,true); e.setUint16(6,0,true);
  e.setUint16(8, arquivos.length, true); e.setUint16(10, arquivos.length, true);
  e.setUint32(12, cdTam, true); e.setUint32(16, off, true); e.setUint16(20, 0, true);
  return new Blob([...locais, ...centrais, eo], { type:'application/zip' });
}

/* ---------- KMZ validado: é o que alimenta o build_dxf.py ----------
   Diferente do KMZ inicial do painel, que é backup do projeto antes do campo. */
const xe = s => String(s==null?'':s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function postesValidados(){
  return postes.filter(p => { const r = regs[p.barramento];
    return r && (r.status==='ok' || r.status==='divergente'); });
}
function montarKmlValidado(){
  const us = postesValidados();
  const marcas = us.map((p,i) => {
    const r = regs[p.barramento] || {};
    return '<Placemark><name>' + xe(String(i+1).padStart(2,'0')) + '</name><description>'
      + xe('Barramento: ' + p.barramento
           + '\nLatitude: ' + p.lat.toFixed(7) + '\nLongitude: ' + p.lon.toFixed(7)
           + (p.cod_id ? '\nCOD_ID BDGD: ' + p.cod_id : '')
           + (r.ocupantes_campo!=null ? '\nOcupantes em campo: ' + r.ocupantes_campo : '')
           + (p.logradouro ? '\nLogradouro: ' + p.logradouro : '')
           + (p.novo ? '\nNAO CADASTRADO NO GEOSWEB' : p.fora_da_os ? '\nFORA DA OS — incluir no GEOSWEB' : ''))
      + '</description><styleUrl>#poste</styleUrl><Point><coordinates>'
      + p.lon.toFixed(7) + ',' + p.lat.toFixed(7) + ',0</coordinates></Point></Placemark>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>'
    + xe((cfg.os||'projeto') + ' — rota validada em campo') + '</name>'
    + '<Style id="poste"><IconStyle><scale>0.9</scale><Icon><href>'
    + 'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>'
    + '<Style id="rota"><LineStyle><color>ff2e8b0f</color><width>3</width></LineStyle></Style>'
    + '<Folder><name>Postes</name>' + marcas + '</Folder>'
    + '<Placemark><name>ACESSO</name><styleUrl>#rota</styleUrl><LineString><tessellate>1</tessellate>'
    + '<coordinates>' + us.map(p => p.lon.toFixed(7)+','+p.lat.toFixed(7)+',0').join(' ')
    + '</coordinates></LineString></Placemark></Document></kml>';
}

/* ---------- 14. Exportação ---------- */
function csvInventario(){
  const cab = ['ID','BARRAMENTO','COD_ID','ORIGEM','OCUPACAO_PRODEPA','LOGRADOURO','LAT_BASE','LON_BASE','STATUS','OCUP_GEOSWEB','OCUP_CAMPO',
    'DIVERGENCIA','FOTO_ABERTA','FOTO_DETALHE','NITIDEZ_A','NITIDEZ_D','AZIMUTE_A','LAT_GPS','LON_GPS',
    'PRECISAO_GPS_M','RANKING','DIST_M','DESVIO_RUMO','BUSSOLA_OFF','MOTIVO_DESCARTE','DATA_HORA','OBS'];
  const lin = postes.map(p => {
    const r = regs[p.barramento] || {};
    const div = r.ocupantes_campo!=null && p.ocupantes!=null && r.ocupantes_campo!==p.ocupantes;
    return [
      p.seq!=null?p.seq:'', p.barramento, p.cod_id||'',
      p.novo?'NAO_CADASTRADO':(p.fora_da_os?'BDGD_FORA_DA_OS':'GEOSWEB'), p.ocupacao_prodepa?'TEM':'SEM',
      (p.logradouro||'').replace(/;/g,','),
      virg(p.lat,7), virg(p.lon,7),
      r.status || 'pendente',
      p.ocupantes!=null?p.ocupantes:'', r.ocupantes_campo!=null?r.ocupantes_campo:'',
      div?'SIM':(r.status?'NAO':''),
      r.fotoA?nomeFoto(p,'A'):'', r.fotoD?nomeFoto(p,'D'):'',
      r.metaA?r.metaA.nitidez:'', r.metaD?r.metaD.nitidez:'',
      r.metaA&&r.metaA.azimute!=null?r.metaA.azimute:'',
      r.gps_lat!=null?virg(r.gps_lat,7):'', r.gps_lon!=null?virg(r.gps_lon,7):'',
      r.gps_precisao!=null?r.gps_precisao:'',
      r.ranking!=null?r.ranking:(r.ranking_busca?'busca':''),
      r.dist_m!=null?virg(r.dist_m,1):'', r.desvio_rumo!=null?r.desvio_rumo:'',
      cfg.bussolaOff||0, r.motivo||'',
      r.quando||'', (r.obs||'').replace(/[;\r\n]/g,' ')
    ].join(';');
  });
  return '﻿' + cab.join(';') + '\r\n' + lin.join('\r\n') + '\r\n';
}
function csvRanking(){
  const cab = ['BARRAMENTO','POSICAO_RANKING','BUSCA_MANUAL','DIST_M','DESVIO_RUMO_GRAUS','PRECISAO_GPS_M','FONTE_RUMO','DATA_HORA'];
  const lin = Object.values(regs).filter(r=>r.status!=='pendente').map(r => [
    r.barramento, r.ranking!=null?r.ranking:'', r.ranking_busca?'SIM':'NAO',
    r.dist_m!=null?virg(r.dist_m,1):'', r.desvio_rumo!=null?r.desvio_rumo:'',
    r.gps_precisao!=null?r.gps_precisao:'', r.rumo_fonte||'', r.quando||''
  ].join(';'));
  return '﻿' + cab.join(';') + '\r\n' + lin.join('\r\n') + '\r\n';
}
function baixar(blob, nome){
  const u = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = u; a.download = nome; document.body.appendChild(a); a.click();
  setTimeout(()=>{ a.remove(); URL.revokeObjectURL(u); }, 1500);
}
function nomeBase(){ return limpaNome(cfg.os||'SEM-OS'); }
function nomePacote(){
  return limpaNome((cfg.os||'SEM-OS') + '_' + (cfg.projeto||'INVENTARIO')) + '_' + agora().slice(0,10);
}
async function gerarZip(){
  if (!postes.length) return toast('Nenhum pacote de campo carregado');
  const enc = new TextEncoder();
  const arqs = [];
  $('#infoZip').textContent = 'Montando pacote…';
  let n = 0;
  for (const p of postes){
    const r = regs[p.barramento]; if (!r) continue;
    for (const [chave, tipo] of [[r.fotoA,'A'], [r.fotoD,'D']]){
      if (!chave) continue;
      const b = await fotoGet(chave);
      if (b) { arqs.push({ nome:'fotos/'+nomeFoto(p,tipo), dados:new Uint8Array(await b.arrayBuffer()) }); n++; }
    }
  }
  arqs.push({ nome:'inventario.csv', dados:enc.encode(csvInventario()) });
  if (postesValidados().length)
    arqs.push({ nome: nomeBase()+'_VALIDADO.kml', dados:enc.encode(montarKmlValidado()) });
  arqs.push({ nome:'ranking.csv', dados:enc.encode(csvRanking()) });
  arqs.push({ nome:'inventario.json', dados:enc.encode(JSON.stringify({
    gerado_em: agora(), app:'inventario-postes v0', cfg, postes, registros: regs }, null, 1)) });
  arqs.push({ nome:'LEIA-ME.txt', dados:enc.encode(
    'Inventário de postes — NT.00016.EQTL\r\n'
    + 'OS: '+(cfg.os||'—')+'\r\nProjeto: '+(cfg.projeto||'—')+'\r\nMunicípio: '+(cfg.municipio||'—')+'\r\n'
    + 'Gerado em: '+agora()+'\r\n\r\n'
    + 'fotos/      pares por poste, no padrão <OS>_<ID>_<BARRAMENTO>_A|D.jpg\r\n'
    + '            A = foto aberta do poste inteiro; D = detalhe da ocupação.\r\n'
    + '            Cada foto traz tarja com poste, OS, data/hora, coordenada e azimute.\r\n'
    + 'inventario.csv   uma linha por poste do pacote (ponto-e-virgula, virgula decimal).\r\n'
    + '            ORIGEM=CAMPO marca poste que existe em campo e NAO consta do GEOSWEB:\r\n'
    + '            sem ID_PONTO, ancorado em ENTRA_APOS, pendente de cadastro na concessionaria.\r\n'
    + '            BUSSOLA_OFF = correcao de bussola aplicada no aparelho, em graus.\r\n'
    + 'ranking.csv      telemetria de identificacao: em que posicao da lista estava o poste confirmado.\r\n'
    + '            Postes ja registrados sao rebaixados no ranking, para o proximo pendente subir\r\n'
    + '            sozinho; a posicao medida e, portanto, entre os postes ainda pendentes.\r\n'
    + 'inventario.json  manifesto completo, para o gerador do dossiê.\r\n')});
  const b = zip(arqs);
  baixar(b, nomePacote()+'.zip');
  $('#infoZip').innerHTML = '<b>Pacote gerado:</b> '+n+' fotos · '+(b.size/1048576).toFixed(1)+' MB';
  toast('ZIP gerado');
}
function pintarExport(){
  const t = postes.length;
  const v = Object.values(regs);
  const ok = v.filter(r=>r.status==='ok').length;
  const dv = v.filter(r=>r.status==='divergente').length;
  const ne = v.filter(r=>r.status==='descartado').length;
  const borradas = v.filter(r => (r.metaA && !r.metaA.nitido) || (r.metaD && !r.metaD.nitido)).length;
  const nv = postes.filter(p=>p.novo).length;
  $('#kpis').innerHTML = [
    [t,'postes'],[ok,'conformes'],[dv,'divergentes'],[ne,'descartados'],
    [t-(ok+dv+ne),'pendentes'],[borradas,'fotos borradas'],[nv,'fora da base']
  ].map(k => '<div class="kpi"><b>'+k[0]+'</b><span>'+k[1]+'</span></div>').join('');

  const feitos = v.filter(r=>r.status!=='pendente');
  const c1 = feitos.filter(r=>r.ranking===1).length;
  const c2 = feitos.filter(r=>r.ranking===2).length;
  const c3 = feitos.filter(r=>r.ranking===3).length;
  const cb = feitos.filter(r=>r.ranking_busca).length;
  const tot = feitos.length || 1;
  const pc = n => (n/tot*100).toFixed(0)+'%';
  $('#tabRank').innerHTML = '<tr><th>Posição</th><th class="n">Postes</th><th class="n">Share</th></tr>'
    + [['1º candidato (acerto direto)',c1],['2º candidato',c2],['3º candidato',c3],['Busca manual',cb]]
      .map(r => '<tr><td>'+r[0]+'</td><td class="n">'+r[1]+'</td><td class="n">'+pc(r[1])+'</td></tr>').join('')
    + '<tr><td><b>Acerto no topo</b></td><td class="n"><b>'+c1+'/'+feitos.length+'</b></td><td class="n"><b>'+pc(c1)+'</b></td></tr>';

  const novos = postes.filter(p=>p.novo).map(p =>
    '<div class="aviso"><b>'+esc(p.barramento)+'</b> — poste em campo fora do GEOSWEB'
    + ' — não cadastrado no GEOSWEB, ID_PONTO ' + p.seq
    + '. Entra no ANEXO B com a coordenada como nº do poste.</div>').join('');
  const divs = v.filter(r => r.status==='divergente' || r.status==='descartado'
    || (r.metaA&&!r.metaA.nitido) || (r.metaD&&!r.metaD.nitido));
  $('#listaDiv').innerHTML = novos + (!divs.length
    ? ''
    : divs.map(r => {
        const mot = [];
        if (r.status==='divergente') mot.push('ocupantes: GEOSWEB '+r.ocupantes_geosweb+' × campo '+r.ocupantes_campo);
        if (r.status==='descartado') mot.push('descartado: ' +
          ((MOTIVOS.find(m=>m[0]===r.motivo)||[,'motivo não informado'])[1]).toLowerCase());
        if (r.metaA&&!r.metaA.nitido) mot.push('foto aberta possivelmente borrada');
        if (r.metaD&&!r.metaD.nitido) mot.push('foto de detalhe possivelmente borrada');
        if (r.obs) mot.push('obs.: '+r.obs);
        return '<div class="aviso'+(r.status==='descartado'?' erro':'')+'"><b>'+esc(r.barramento)+'</b><br>'+esc(mot.join(' · '))+'</div>';
      }).join(''));
  if (!novos && !divs.length) $('#listaDiv').innerHTML = '<div class="aviso ok">Nenhuma divergência registrada.</div>';
}

/* ---------- 15. Configuração e início ---------- */
function pintarCfg(){
  $('#fOs').value = cfg.os||''; $('#fProj').value = cfg.projeto||''; $('#fMun').value = cfg.municipio||'';
  $('#fOE').value = cfg.offE; $('#fON').value = cfg.offN; $('#fK').value = cfg.k;
  $('#fNit').value = cfg.nitidez; $('#fPx').value = cfg.maxPx;
  $('#fBus').value = cfg.bussolaOff || 0;
}
async function pintarArmazenamento(){
  const el = $('#infoArm');
  let s = 'Versão do app: ' + VERSAO + '. ' + Object.values(regs).filter(r=>r.status!=='pendente').length + ' registros gravados.';
  try{
    if (navigator.storage && navigator.storage.estimate){
      const e = await navigator.storage.estimate();
      s += ' Usado ' + (e.usage/1048576).toFixed(1) + ' MB de ~' + (e.quota/1048576).toFixed(0) + ' MB disponíveis.';
    }
  }catch(e){}
  el.textContent = s;
}
function aba(t){
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.t===t));
  $$('.tela').forEach(s => s.classList.toggle('on', s.id==='t-'+t));
  if (t==='campo') setTimeout(desenharMapa, 60);
  if (t==='postes') pintarLista();
  if (t==='exportar') pintarExport();
  if (t==='projeto') pintarArmazenamento();
  window.scrollTo(0,0);
}
async function iniciar(){
  cfg = Object.assign({}, CFG_PADRAO, (await kvGet('cfg')) || {});
  postes = (await kvGet('postes')) || [];
  regs = (await kvGet('regs')) || {};
  pintarCfg(); pintarBase(); pintarProgresso(); pintarLista(); pintarExport(); pintarArmazenamento();
  if (postes.length){ $('#semBase').classList.add('oculto'); $('#blocoCampo').classList.remove('oculto'); }

  $$('nav button').forEach(b => b.onclick = () => aba(b.dataset.t));
  $$('#filtros button').forEach(b => b.onclick = () => {
    filtro = b.dataset.f; $$('#filtros button').forEach(x=>x.classList.toggle('on', x===b)); pintarLista(); });
  $('#mFechar').onclick = fecharModal;
  $('#modal').onclick = e => { if (e.target.id==='modal') fecharModal(); };
  $('#btnBuscar').onclick = abrirBusca;
  $('#btnNovoPoste').onclick = abrirNovoPoste;
  $('#camA').onchange = () => receberFoto($('#camA'),'A');
  $('#camD').onchange = () => receberFoto($('#camD'),'D');
  $('#btnImportar').onclick = () => $('#fBase').click();
  $('#fBase').onchange = async e => {
    const f = e.target.files[0]; e.target.value='';
    if (!f) return;
    try{ await importarArquivo(f); }
    catch(err){ console.error(err);
      $('#infoBase').innerHTML = '<span style="color:var(--erro)"><b>Não consegui ler este arquivo.</b><br>'
        + esc(err.message) + '<br><span style="color:var(--neutro)">Arquivo: ' + esc(f.name)
        + ' · ' + (f.size/1024).toFixed(1) + ' KB</span></span>';
      toast('Importação falhou — veja o motivo abaixo do botão', 5000); }
  };
  $('#btnDemo').onclick = async () => {
    if (!pos){ toast('Aguardando o GPS para posicionar os postes de teste…', 3000); return; }
    postes = pacoteDemo(); await kvSet('postes', postes);
    if (!cfg.os){ cfg.os='2026.01.054880000000'; cfg.projeto='DEMONSTRAÇÃO'; cfg.municipio='Belém'; await kvSet('cfg',cfg); pintarCfg(); }
    pintarBase(); pintarLista(); pintarProgresso(); pintarExport(); ranquear();
    $('#semBase').classList.add('oculto'); $('#blocoCampo').classList.remove('oculto');
    toast('14 postes de teste criados em volta de você'); aba('campo');
  };
  $('#btnLimparBase').onclick = async () => {
    if (!confirm('Limpar a base de postes? Os registros já feitos permanecem.')) return;
    postes = []; await kvSet('postes', postes);
    pintarBase(); pintarLista(); pintarProgresso();
    $('#semBase').classList.remove('oculto'); $('#blocoCampo').classList.add('oculto');
  };
  $('#btnSalvarCfg').onclick = async () => {
    cfg.os = $('#fOs').value.trim(); cfg.projeto = $('#fProj').value.trim(); cfg.municipio = $('#fMun').value.trim();
    await kvSet('cfg', cfg); pintarProgresso(); toast('Identificação salva');
  };
  $('#btnSalvarCal').onclick = async () => {
    cfg.offE = num($('#fOE').value,0); cfg.offN = num($('#fON').value,0);
    cfg.k = num($('#fK').value,0.35); cfg.nitidez = num($('#fNit').value,60);
    cfg.maxPx = Math.max(600, num($('#fPx').value,1600)|0);
    cfg.bussolaOff = Math.round(num($('#fBus').value,0));
    await kvSet('cfg', cfg); ranquear(); toast('Calibração salva');
  };
  $('#btnAtualizar').onclick = async () => {
    if (!confirm('Buscar a versão mais nova do app? Os registros e fotos deste aparelho são preservados.')) return;
    toast('Atualizando…', 4000);
    try{
      if ('serviceWorker' in navigator){
        const rs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(rs.map(r => r.unregister()));
      }
      if (window.caches){
        const ks = await caches.keys();
        await Promise.all(ks.map(k => caches.delete(k)));
      }
    }catch(e){ console.warn(e); }
    location.reload(true);
  };
  $('#btnZip').onclick = gerarZip;
  $('#btnCsvSo').onclick = () => baixar(new Blob([csvInventario()],{type:'text/csv;charset=utf-8'}), nomePacote()+'.csv');
  $('#btnKmzVal').onclick = () => {
    if (!postesValidados().length) return toast('Nenhum poste validado ainda');
    baixar(zip([{nome:'doc.kml', dados:new TextEncoder().encode(montarKmlValidado())}]),
           nomeBase()+'_VALIDADO.kmz');
  };
  $('#btnZerar').onclick = async () => {
    if (!confirm('Zerar TODOS os registros e fotos deste aparelho? Exporte antes.')) return;
    regs = {}; await kvSet('regs', regs); await fotosLimpar();
    pintarLista(); pintarProgresso(); pintarExport(); pintarArmazenamento(); ranquear(); toast('Registros zerados');
  };
  window.addEventListener('resize', () => setTimeout(desenharMapa, 60));
  window.addEventListener('orientationchange', () => setTimeout(desenharMapa, 240));

  iniciarGps(); iniciarBussola(); setTimeout(desenharMapa, 120);

  if ('serviceWorker' in navigator){
    try{
      // updateViaCache:'none' faz o navegador ignorar o cache HTTP ao conferir o sw.js.
      // Sem isso, o cache de 10 min do GitHub Pages segura a atualização.
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache:'none' });
      reg.update().catch(()=>{});
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!window.__recarregando){ window.__recarregando = true; location.reload(); }
      });
    }catch(e){ console.warn('SW', e); }
  }
}
iniciar();
