/* Painel do Projetista — v0.1
   Entrada: Planilha Detalhada do GEOSWEB + recorte do município (BDGD).
   Saída: pacote do app de campo, KMZ inicial de backup, e — na volta —
   as três listas que o projetista precisa executar no GEOSWEB. */
'use strict';
const VERSAO = 'v0.2';

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const virg = (n,d=2) => n==null||!Number.isFinite(n) ? '' : n.toFixed(d).replace('.',',');
let toastT;
function toast(m, ms=2800){ const t=$('#toast'); t.textContent=m; t.classList.add('on');
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('on'), ms); }
function baixar(blob, nome){ const u=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=u; a.download=nome; document.body.appendChild(a); a.click();
  setTimeout(()=>{a.remove(); URL.revokeObjectURL(u);}, 1200); }
const semAcento = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();

/* ---------- geometria ---------- */
const R=6371008.8, g2r=Math.PI/180;
function distM(a,b){ const m=(a.lat+b.lat)/2*g2r;
  return Math.hypot((b.lon-a.lon)*g2r*Math.cos(m), (b.lat-a.lat)*g2r)*R; }
/* Vão geodésico — mesma regra do vaos_geodesicos.py: desenhar em UTM, medir no elipsoide */
const A_=6378137.0, E2=(1/298.257222101)*(2-1/298.257222101);
function vaoGeo(p,q){ const lat0=(p.lat+q.lat)/2*g2r, s=Math.sin(lat0), w=1-E2*s*s;
  const n=A_/Math.sqrt(w), m=A_*(1-E2)/(w*Math.sqrt(w));
  return Math.hypot(n*Math.cos(lat0)*(q.lon-p.lon)*g2r, m*(q.lat-p.lat)*g2r); }

/* ---------- logradouro pelo OSM ----------
   Abreviaturas conforme o PROMPT-MESTRE §Passo 8. Sem número de porta: o OSM
   não tem, e a regra manda não inventar — sai S/N. */
const ABREV = [[/^avenida\s+/i,'Av. '],[/^travessa\s+/i,'Tv. '],[/^passagem\s+/i,'Pass. '],
               [/^rua\s+/i,'R. '],[/^estrada\s+/i,'Estr. ']];
const ABREV_MEIO = [[/\bdoutor\b/gi,'Dr.'],[/\bdoutora\b/gi,'Dra.'],
                    [/\bprofessor\b/gi,'Prof.'],[/\bprofessora\b/gi,'Profa.']];
function abreviar(nome){
  let n = String(nome||'').trim();
  for (const [re, ab] of ABREV) if (re.test(n)){ n = n.replace(re, ab); break; }
  for (const [re, ab] of ABREV_MEIO) n = n.replace(re, ab);
  return n;
}
/* Distância de um ponto a um segmento, em metros, no plano local. */
function distSeg(p, a, b){
  const m = p.lat*g2r, kx = Math.cos(m)*R*g2r, ky = R*g2r;
  const px=(p.lon-a[1])*kx, py=(p.lat-a[0])*ky;
  const bx=(b[1]-a[1])*kx,  by=(b[0]-a[0])*ky;
  const L = bx*bx + by*by;
  let t = L ? (px*bx + py*by)/L : 0;
  t = t<0?0:t>1?1:t;
  return Math.hypot(px - t*bx, py - t*by);
}
/* Índice das vias por célula de grade, para não varrer 16 mil linhas por poste. */
function indexarVias(vias, celula=0.0025){
  const g = new Map();
  vias.forEach((v, iv) => {
    const pts = v[1];
    for (let i=0;i<pts.length-1;i++){
      const a=pts[i], b=pts[i+1];
      const la0=Math.min(a[0],b[0]), la1=Math.max(a[0],b[0]);
      const lo0=Math.min(a[1],b[1]), lo1=Math.max(a[1],b[1]);
      for (let x=Math.floor(la0/celula); x<=Math.floor(la1/celula); x++)
        for (let y=Math.floor(lo0/celula); y<=Math.floor(lo1/celula); y++){
          const k = x+'_'+y; if (!g.has(k)) g.set(k, []); g.get(k).push([iv, i]);
        }
    }
  });
  return { g, celula };
}
function viaMaisProxima(idx, vias, p, limite=60){
  const { g, celula } = idx;
  const a = Math.floor(p.lat/celula), b = Math.floor(p.lon/celula);
  let melhor = null;
  for (let i=-1;i<=1;i++) for (let j=-1;j<=1;j++){
    const lista = g.get((a+i)+'_'+(b+j)); if (!lista) continue;
    for (const [iv, is] of lista){
      const pts = vias[iv][1];
      const d = distSeg(p, pts[is], pts[is+1]);
      if (!melhor || d < melhor.d) melhor = { d, nome: vias[iv][0] };
    }
  }
  return melhor && melhor.d <= limite ? melhor : null;
}
function compor(via, bairro, cidade, cep){
  if (!via) return '';
  const p = [abreviar(via) + ', S/N'];
  if (bairro) p.push(' - ' + bairro);
  const c = [cidade, cep].filter(Boolean);
  return p.join('') + (cidade ? ', ' + cidade + ' - PA' : '') + (cep ? ', ' + cep : '') + ', Brasil';
}

/* ---------- estado ---------- */
let OS='', tipoOS='', postes=[], base=null, municipio='', cinturao=[], qualidade=null, idxVias=null;

/* ---------- leitura da planilha ---------- */
const COLS = {
  elemento:['elemento'], barramento:['barramento'], lat:['latitude'], lon:['longitude'],
  servicos:['servicos'], ocupante:['ocupante'], empresa:['empresa associada'],
  contrato:['contrato'], irregularidades:['irregularidades'],
  qtd_cabos:['quantidade de cabos'], tipo_cabo:['tipo de cabo'], subtipo:['subtipo de cabo'],
  inclusao:['inclusao'], nota_sap:['nota sap']
};
/* O Excel corta o nome da aba em 31 caracteres; o GEOSWEB usa a aba para
   dizer o tipo da OS, então reconstituímos o nome inteiro. */
const TIPOS_OS = {
  'solicitacao de novo compartilha': 'Solicitação de Novo Compartilhamento',
  'regularizacao de ocupacao a rev': 'Regularização de Ocupação à Revelia'
};
function tipoCompleto(aba){
  const k = semAcento(aba);
  for (const [p, nome] of Object.entries(TIPOS_OS)) if (k.startsWith(p.slice(0,24))) return nome;
  return aba;
}
function lerPlanilha(buf, nomeArquivo){
  const wb = XLSX.read(buf, { type:'array' });
  const nomeAba = wb.SheetNames[0];
  // O exportador declara !ref errado e a leitura normal devolve zero linhas.
  // Recalcular o intervalo a partir das células que existem de fato.
  const ws = wb.Sheets[nomeAba];
  const chaves = Object.keys(ws).filter(k => k[0] !== '!');
  if (chaves.length){
    let maxL=0, maxC=0;
    chaves.forEach(k => { const d = XLSX.utils.decode_cell(k);
      if (d.r>maxL) maxL=d.r; if (d.c>maxC) maxC=d.c; });
    ws['!ref'] = XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:maxL,c:maxC} });
  }
  const linhas = XLSX.utils.sheet_to_json(ws, { header:1, defval:null, raw:true });
  const limpas = linhas.filter(l => l && l.some(c => c!=null && String(c).trim()));
  if (limpas.length < 2) throw new Error('A planilha não tem linhas de dados.');
  const cab = limpas[0].map(c => semAcento(c));
  const idx = {};
  for (const [k, alvos] of Object.entries(COLS)){
    let i = cab.findIndex(c => alvos.includes(c));
    if (i < 0) i = cab.findIndex(c => alvos.some(a => c.includes(a)));
    if (i >= 0) idx[k] = i;
  }
  if (idx.barramento==null || idx.lat==null || idx.lon==null)
    throw new Error('Não achei as colunas Barramento, Latitude e Longitude. Cabeçalho lido: ' + limpas[0].join(' | '));

  const porBarr = new Map();
  for (const l of limpas.slice(1)){
    const b = l[idx.barramento]==null ? '' : String(l[idx.barramento]).trim();
    const lat = parseFloat(l[idx.lat]), lon = parseFloat(l[idx.lon]);
    if (!b || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let p = porBarr.get(b);
    if (!p){ p = { barramento:b, lat, lon, ocupacoes:new Set(), irregularidades:new Set(),
                   prodepa:false, servicos:'', elemento:'' }; porBarr.set(b, p); }
    p.elemento = l[idx.elemento] || p.elemento;
    p.servicos = l[idx.servicos] || p.servicos;
    // ocupantes = tuplas distintas (Ocupante, Nota SAP, Inclusão) — regra do pipeline
    p.ocupacoes.add([l[idx.ocupante]||'', String(l[idx.nota_sap]||'').trim(), l[idx.inclusao]||''].join('|'));
    const ir = String(l[idx.irregularidades]||'').trim();
    if (ir && !/^não possui/i.test(ir) && !/^nao possui/i.test(ir)) p.irregularidades.add(ir);
    const emp = (String(l[idx.empresa]||'') + ' ' + String(l[idx.ocupante]||'')).toUpperCase();
    if (emp.includes('TECNOLOGIA DA INFORMA') || emp.includes('PRODEPA')) p.prodepa = true;
  }
  const lista = Array.from(porBarr.values()).map(p => ({
    barramento:p.barramento, lat:p.lat, lon:p.lon,
    ocupantes:p.ocupacoes.size,
    irregularidades:Array.from(p.irregularidades).join(' · '),
    ocupacao_prodepa:p.prodepa, servicos:String(p.servicos||''), origem:'GEOSWEB'
  }));
  // dedupe geométrico < 1 m (R14)
  const fora = [];
  for (let i=0;i<lista.length;i++) for (let j=i+1;j<lista.length;j++)
    if (distM(lista[i], lista[j]) < 1) fora.push([lista[i].barramento, lista[j].barramento]);
  const os = (nomeArquivo.match(/(\d{4}\.\d{2}\.\d{10,})/) || [])[1] || '';
  return { os, tipoOS:tipoCompleto(nomeAba), postes:lista, linhas:limpas.length-1, coincidentes:fora };
}

/* ---------- recorte do município ---------- */
async function lerMunicipio(file){
  let txt;
  if (/\.gz$/i.test(file.name)){
    if (!('DecompressionStream' in window)) throw new Error('Este navegador não descompacta .gz — use Chrome ou Edge atualizado.');
    const ds = new DecompressionStream('gzip');
    txt = await new Response(file.stream().pipeThrough(ds)).text();
  } else txt = await file.text();
  const d = JSON.parse(txt);
  const c = d.campos;
  const iC=c.indexOf('cod_id'), iLa=c.indexOf('lat'), iLo=c.indexOf('lon'),
        iA=c.indexOf('altura'), iE=c.indexOf('esforco'), iM=c.indexOf('material'),
        iS=c.indexOf('estrutura'), iB=c.indexOf('bt'), iT=c.indexOf('mt'), iU=c.indexOf('area');
  return { municipio:d.municipio, vias: d.vias || [], postes: d.postes.map(p => ({
    cod_id:p[iC], lat:p[iLa], lon:p[iLo], altura:p[iA], esforco:p[iE],
    material:p[iM], estrutura:p[iS], bt:p[iB], mt:p[iT], urbano:p[iU] })) };
}

/* ---------- vínculo com a BDGD ---------- */
function grade(pts, celula=0.0012){   // ~130 m
  const g = new Map();
  pts.forEach((p,i) => { const k = Math.round(p.lat/celula)+'_'+Math.round(p.lon/celula);
    if (!g.has(k)) g.set(k, []); g.get(k).push(i); });
  return { g, celula };
}
function vizinhos(idx, p, raioCelulas=1){
  const { g, celula } = idx, out = [];
  const a = Math.round(p.lat/celula), b = Math.round(p.lon/celula);
  for (let i=-raioCelulas;i<=raioCelulas;i++) for (let j=-raioCelulas;j<=raioCelulas;j++){
    const v = g.get((a+i)+'_'+(b+j)); if (v) out.push(...v);
  }
  return out;
}
function vincular(postes, basePostes){
  const idx = grade(basePostes);
  const ds = [];
  postes.forEach(p => {
    let melhor = null;
    for (const k of vizinhos(idx, p)){
      const d = distM(p, basePostes[k]);
      if (!melhor || d < melhor.d) melhor = { d, b:basePostes[k] };
    }
    if (melhor && melhor.d <= 40){
      p.cod_id = melhor.b.cod_id; p.altura = melhor.b.altura; p.esforco = melhor.b.esforco;
      p.material = melhor.b.material; p.estrutura = melhor.b.estrutura;
      p.bt = melhor.b.bt; p.mt = melhor.b.mt; p.urbano = melhor.b.urbano;
      p.dist_bdgd = melhor.d;
    } else p.dist_bdgd = null;
    if (p.dist_bdgd!=null) ds.push(p.dist_bdgd);
  });
  ds.sort((a,b)=>a-b);
  const med = ds.length ? ds[Math.floor(ds.length/2)] : null;
  const p90 = ds.length ? ds[Math.floor(ds.length*0.9)] : null;
  // Tolerância adaptativa: em Santarém o erro é espalhamento de ±6 m, não vetor fixo.
  const tol = med==null ? null : Math.max(5, Math.ceil(p90 + 2));
  return { vinculados:ds.length, total:postes.length, mediana:med, p90, tolerancia:tol };
}

/* ---------- rota: caminho aberto, vizinho mais próximo + 2-opt ---------- */
function rotear(pts){
  if (pts.length < 3) return pts.map((_,i)=>i);
  const n = pts.length, usado = new Array(n).fill(false);
  // começa pelo ponto mais extremo, que costuma ser uma ponta da rota
  let ini = 0, maxd = -1;
  const c = { lat: pts.reduce((s,p)=>s+p.lat,0)/n, lon: pts.reduce((s,p)=>s+p.lon,0)/n };
  pts.forEach((p,i) => { const d = distM(c,p); if (d>maxd){ maxd=d; ini=i; } });
  const ordem = [ini]; usado[ini] = true;
  for (let k=1;k<n;k++){
    const u = pts[ordem[ordem.length-1]];
    let melhor=-1, md=Infinity;
    for (let i=0;i<n;i++) if (!usado[i]){ const d=distM(u,pts[i]); if (d<md){ md=d; melhor=i; } }
    ordem.push(melhor); usado[melhor]=true;
  }
  const comp = o => { let s=0; for (let i=0;i<o.length-1;i++) s+=distM(pts[o[i]],pts[o[i+1]]); return s; };
  let melhorou = true, voltas = 0;
  while (melhorou && voltas < 60){
    melhorou = false; voltas++;
    for (let i=0;i<ordem.length-2;i++) for (let j=i+2;j<ordem.length;j++){
      const a=pts[ordem[i]], b=pts[ordem[i+1]], cc=pts[ordem[j]],
            d=j+1<ordem.length?pts[ordem[j+1]]:null;
      const antes = distM(a,b) + (d?distM(cc,d):0);
      const depois = distM(a,cc) + (d?distM(b,d):0);
      if (depois < antes - 1e-9){
        const trecho = ordem.slice(i+1, j+1).reverse();
        ordem.splice(i+1, trecho.length, ...trecho);
        melhorou = true;
      }
    }
  }
  return ordem;
}

/* ---------- ZIP store-only (para o KMZ) ---------- */
const CRCT=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;
  for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(u){let c=0xFFFFFFFF;for(let i=0;i<u.length;i++)c=CRCT[(c^u[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function zip(arqs){
  const enc=new TextEncoder(), d=new Date();
  const dt={t:((d.getHours()&31)<<11)|((d.getMinutes()&63)<<5)|((d.getSeconds()/2)&31),
            d:(((d.getFullYear()-1980)&127)<<9)|(((d.getMonth()+1)&15)<<5)|(d.getDate()&31)};
  const loc=[],cen=[];let off=0;
  arqs.forEach(a=>{const nm=enc.encode(a.nome),cr=crc32(a.dados),t=a.dados.length;
    const lh=new Uint8Array(30+nm.length),v=new DataView(lh.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x0800,true);
    v.setUint16(8,0,true);v.setUint16(10,dt.t,true);v.setUint16(12,dt.d,true);
    v.setUint32(14,cr,true);v.setUint32(18,t,true);v.setUint32(22,t,true);
    v.setUint16(26,nm.length,true);v.setUint16(28,0,true);lh.set(nm,30);
    loc.push(lh,a.dados);
    const ch=new Uint8Array(46+nm.length),w=new DataView(ch.buffer);
    w.setUint32(0,0x02014b50,true);w.setUint16(4,20,true);w.setUint16(6,20,true);
    w.setUint16(8,0x0800,true);w.setUint16(10,0,true);w.setUint16(12,dt.t,true);w.setUint16(14,dt.d,true);
    w.setUint32(16,cr,true);w.setUint32(20,t,true);w.setUint32(24,t,true);
    w.setUint16(28,nm.length,true);w.setUint32(42,off,true);ch.set(nm,46);
    cen.push(ch); off+=lh.length+t;});
  const cd=cen.reduce((s,c)=>s+c.length,0);
  const eo=new Uint8Array(22),e=new DataView(eo.buffer);
  e.setUint32(0,0x06054b50,true);e.setUint16(8,arqs.length,true);e.setUint16(10,arqs.length,true);
  e.setUint32(12,cd,true);e.setUint32(16,off,true);
  return new Blob([...loc,...cen,eo],{type:'application/vnd.google-earth.kmz'});
}

/* ---------- KML ---------- */
const xe = s => String(s==null?'':s).replace(/[&<>]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function montarKml(titulo, pts, linha){
  const marcas = pts.map((p,i) =>
    '<Placemark><name>' + xe(String(i+1).padStart(2,'0')) + '</name><description>'
    + xe('Barramento: ' + p.barramento + '\nLatitude: ' + p.lat.toFixed(7)
         + '\nLongitude: ' + p.lon.toFixed(7)
         + (p.ocupantes!=null ? '\nOcupantes: ' + p.ocupantes : '')
         + (p.cod_id ? '\nCOD_ID BDGD: ' + p.cod_id : '')
         + (p.origem ? '\nOrigem: ' + p.origem : ''))
    + '</description><styleUrl>#poste</styleUrl><Point><coordinates>'
    + p.lon.toFixed(7) + ',' + p.lat.toFixed(7) + ',0</coordinates></Point></Placemark>').join('');
  const acesso = linha
    ? '<Placemark><name>ACESSO</name><styleUrl>#rota</styleUrl><LineString><tessellate>1</tessellate>'
      + '<coordinates>' + pts.map(p => p.lon.toFixed(7)+','+p.lat.toFixed(7)+',0').join(' ')
      + '</coordinates></LineString></Placemark>' : '';
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + xe(titulo) + '</name>'
    + '<Style id="poste"><IconStyle><scale>0.9</scale><Icon><href>'
    + 'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>'
    + '<Style id="rota"><LineStyle><color>ff2e8b0f</color><width>3</width></LineStyle></Style>'
    + '<Folder><name>Postes</name>' + marcas + '</Folder>' + acesso
    + '</Document></kml>';
}

/* ---------- tela: preparar ---------- */
function processar(){
  if (!postes.length) return;
  qualidade = base ? vincular(postes, base.postes) : null;
  const ordem = rotear(postes);
  postes = ordem.map(i => postes[i]);
  postes.forEach((p,i) => p.seq = i+1);
  montarCinturao();
  derivarEnderecos();
  pintarPreparar();
}
function derivarEnderecos(){
  if (!base || !base.vias || !base.vias.length){ postes.forEach(p => { p.via=''; p.logradouro=''; }); return; }
  if (!idxVias) idxVias = indexarVias(base.vias);
  const bairro = ($('#cBairro')||{}).value || '', cidade = ($('#cMunNome')||{}).value || '',
        cep = ($('#cCep')||{}).value || '';
  const aplicar = p => {
    const v = viaMaisProxima(idxVias, base.vias, p);
    p.via = v ? v.nome : '';
    p.dist_via = v ? v.d : null;
    p.logradouro = compor(p.via, bairro, cidade, cep);
  };
  postes.forEach(aplicar);
  cinturao.forEach(aplicar);
}
function montarCinturao(){
  cinturao = [];
  if (!base) return;
  const raio = Math.max(10, parseFloat(($('#cRaio').value||'60').replace(',','.')) || 60);
  const jaTem = new Set(postes.map(p => p.cod_id).filter(Boolean));
  const idx = grade(base.postes);
  const vistos = new Set();
  postes.forEach(p => {
    for (const k of vizinhos(idx, p, 1)){
      if (vistos.has(k)) continue;
      const b = base.postes[k];
      if (jaTem.has(b.cod_id)) continue;
      if (distM(p, b) > raio) continue;
      vistos.add(k);
      cinturao.push({ barramento:'', cod_id:b.cod_id, lat:b.lat, lon:b.lon,
        altura:b.altura, esforco:b.esforco, material:b.material, estrutura:b.estrutura,
        bt:b.bt, mt:b.mt, urbano:b.urbano, origem:'BDGD_FORA_DA_OS',
        ocupantes:null, irregularidades:'' });
    }
  });
}
function pintarPreparar(){
  $('#resultado').classList.remove('oculto');
  $('#hdrOs').textContent = OS ? 'OS ' + OS : '';
  const comIrr = postes.filter(p=>p.irregularidades).length;
  const pdp = postes.filter(p=>p.ocupacao_prodepa).length;
  const totOc = postes.reduce((s,p)=>s+(p.ocupantes||0),0);
  let metr = 0; for (let i=0;i<postes.length-1;i++) metr += vaoGeo(postes[i],postes[i+1]);
  $('#kpis').innerHTML = [
    [postes.length,'postes',''], [totOc,'ocupações',''],
    [comIrr,'c/ irregularidade', comIrr?'alerta':''],
    [pdp,'c/ PRODEPA',''],
    [Math.round(metr)+' m','metragem',''],
    [cinturao.length,'cinturão BDGD',''],
    [postes.filter(p=>p.via).length + '/' + postes.length, 'c/ logradouro',
      postes.filter(p=>p.via).length < postes.length ? 'alerta' : '']
  ].map(k=>'<div class="kpi '+k[2]+'"><b>'+k[0]+'</b><span>'+k[1]+'</span></div>').join('');

  const q = qualidade;
  $('#cQualidade').innerHTML = '<h2>Vínculo com a BDGD</h2>' + (!q
    ? '<div class="aviso">Sem o recorte do município. O pacote sai sem atributos da BDGD e <b>sem cinturão</b> — o colaborador não terá alternativa pronta se precisar trocar de poste.</div>'
    : (q.vinculados < q.total
        ? '<div class="aviso erro"><b>'+(q.total-q.vinculados)+' de '+q.total+' postes</b> não acharam par na base a 40 m. Confira se o recorte é do município certo.</div>'
        : '<div class="aviso ok">Todos os '+q.total+' postes acharam par na base.</div>')
      + '<table><tr><th>mediana</th><th>p90</th><th>tolerância sugerida</th><th>município do recorte</th></tr>'
      + '<tr><td class="n">'+virg(q.mediana,1)+' m</td><td class="n">'+virg(q.p90,1)+' m</td>'
      + '<td class="n">'+q.tolerancia+' m</td><td>'+esc(base.municipio)+'</td></tr></table>'
      + '<div class="mini" style="margin-top:8px">A tolerância sai da própria distribuição. Em Santarém o desvio é espalhamento, não vetor fixo, e um deslocamento único pioraria o vínculo.</div>');

  let m = 0, linhas = '';
  postes.forEach((p,i) => {
    const v = i ? vaoGeo(postes[i-1], p) : 0; m += v;
    linhas += '<tr><td class="n">'+p.seq+'</td><td class="barr">'+esc(p.barramento)+'</td>'
      + '<td class="n">'+(i?virg(v,1)+' m':'—')+'</td>'
      + '<td class="n">'+(p.ocupantes||0)+'</td>'
      + '<td>'+(p.altura?esc(p.altura)+' m':'<span class="mini">—</span>')
      + (p.esforco?' · '+esc(p.esforco)+' daN':'')+'</td>'
      + '<td>'+(p.via ? esc(abreviar(p.via)) : '<span class="mini">sem via nomeada</span>')+'</td>'
      + '<td>'+(p.ocupacao_prodepa?'<span class="tag nv">PRODEPA</span> ':'')
      + (p.irregularidades?'<span class="tag er">'+esc(p.irregularidades.split(' · ')[0])+'</span>':'')
      + (p.dist_bdgd!=null && p.dist_bdgd>15?'<span class="tag al">base a '+virg(p.dist_bdgd,0)+' m</span>':'')
      + '</td></tr>';
  });
  $('#tRota').innerHTML = '<tr><th>ID</th><th>Barramento</th><th>vão</th><th>ocup.</th><th>BDGD</th><th>logradouro</th><th></th></tr>' + linhas;
  $('#infoRota').innerHTML = 'Caminho aberto por vizinho mais próximo com 2-opt. Metragem geodésica: <b>'
    + virg(m,1) + ' m</b>. Confira o sentido: o ID 1 deve ser o ponto de presença da PRODEPA.';
}

/* ---------- saídas ---------- */
function nomeBase(){ return (OS || 'SEM-OS').replace(/[^0-9A-Za-z.\-]/g,'_'); }
function montarPacote(){
  return {
    gerado_em: new Date().toISOString().slice(0,19).replace('T',' '),
    painel: VERSAO, os: OS, tipo_os: tipoOS,
    projeto: $('#cProj').value.trim(), municipio: $('#cMunNome').value.trim(),
    vinculo_bdgd: qualidade,
    postes: postes.map(p => ({
      seq:p.seq, barramento:p.barramento, cod_id:p.cod_id||'', lat:p.lat, lon:p.lon,
      altura:p.altura!=null?p.altura+' m':'', esforco:p.esforco!=null?p.esforco+' daN':'',
      material:p.material||'', estrutura:p.estrutura||'',
      bt:!!p.bt, mt:!!p.mt, ocupantes:p.ocupantes,
      irregularidades:p.irregularidades||'', ocupacao_prodepa:!!p.ocupacao_prodepa,
      logradouro:p.logradouro||'', origem:'GEOSWEB'
    })).concat(cinturao.map(p => ({
      seq:null, barramento:'', cod_id:p.cod_id, lat:p.lat, lon:p.lon,
      altura:p.altura!=null?p.altura+' m':'', esforco:p.esforco!=null?p.esforco+' daN':'',
      material:p.material||'', estrutura:p.estrutura||'',
      bt:!!p.bt, mt:!!p.mt, ocupantes:null, irregularidades:'',
      ocupacao_prodepa:false, logradouro:p.logradouro||'', origem:'BDGD_FORA_DA_OS'
    })))
  };
}

function csvEnderecos(){
  const lin = ['BARRAMENTO;ENDERECO'];
  postes.forEach(p => { if (p.logradouro) lin.push(p.barramento + ';' + p.logradouro); });
  return '\uFEFF' + lin.join('\r\n') + '\r\n';
}

/* ---------- retorno do campo ---------- */
let retorno = null;
async function lerZip(file){
  const buf = new Uint8Array(await file.arrayBuffer());
  // lê o diretório central do ZIP e extrai só o inventario.json (armazenado sem compressão)
  let fim = -1;
  for (let i=buf.length-22;i>=0;i--) if (buf[i]===0x50&&buf[i+1]===0x4b&&buf[i+2]===0x05&&buf[i+3]===0x06){ fim=i; break; }
  if (fim<0) throw new Error('ZIP inválido.');
  const dv = new DataView(buf.buffer);
  let off = dv.getUint32(fim+16, true);
  const n = dv.getUint16(fim+10, true), dec = new TextDecoder();
  for (let k=0;k<n;k++){
    const nl=dv.getUint16(off+28,true), el=dv.getUint16(off+30,true), cl=dv.getUint16(off+32,true);
    const nome = dec.decode(buf.subarray(off+46, off+46+nl));
    const metodo = dv.getUint16(off+10, true);
    const lo = dv.getUint32(off+42, true), tam = dv.getUint32(off+24, true);
    if (nome === 'inventario.json'){
      if (metodo !== 0) throw new Error('inventario.json está comprimido; este painel só lê o ZIP do app.');
      const nl2=dv.getUint16(lo+26,true), el2=dv.getUint16(lo+28,true);
      const ini = lo+30+nl2+el2;
      return JSON.parse(dec.decode(buf.subarray(ini, ini+tam)));
    }
    off += 46+nl+el+cl;
  }
  throw new Error('Não achei inventario.json dentro do ZIP.');
}
function pintarRetorno(inv){
  retorno = inv;
  const ps = inv.postes || [], rg = inv.registros || {};
  const st = b => (rg[b]||{}).status || 'pendente';
  const usados    = ps.filter(p => ['ok','divergente'].includes(st(p.barramento)));
  // Descartado é decisão tomada. Pendente é inventário incompleto — nunca vira
  // "desmarcar no GEOSWEB", senão o projetista apaga poste que ninguém visitou.
  const excluir   = ps.filter(p => p.origem!=='BDGD_FORA_DA_OS' && !p.novo && st(p.barramento)==='descartado');
  const pendentes = ps.filter(p => p.origem!=='BDGD_FORA_DA_OS' && !p.novo && st(p.barramento)==='pendente');
  const incluir   = usados.filter(p => p.origem==='BDGD_FORA_DA_OS');
  const cadastrar = usados.filter(p => p.novo);
  const divergentes = usados.filter(p => st(p.barramento)==='divergente');
  const daOS = ps.filter(p => p.origem!=='BDGD_FORA_DA_OS' && !p.novo).length;

  $('#retornoResultado').classList.remove('oculto');
  $('#kpisRet').innerHTML = [
    [daOS,'postes da OS',''], [usados.length,'validados',''],
    [pendentes.length,'pendentes', pendentes.length?'erro':''],
    [excluir.length,'a excluir', excluir.length?'alerta':''],
    [incluir.length,'a incluir', incluir.length?'alerta':''],
    [cadastrar.length,'a cadastrar', cadastrar.length?'erro':''],
    [divergentes.length,'divergência de ocupantes', divergentes.length?'alerta':'']
  ].map(k=>'<div class="kpi '+k[2]+'"><b>'+k[0]+'</b><span>'+k[1]+'</span></div>').join('');

  const MOT = {trocado:'troquei por outro poste', nao_encontrado:'não existe em campo',
               inacessivel:'inacessível ou inviável', sobra:'selecionado a mais'};
  const bloco = (titulo, cor, texto, itens, coluna) => !itens.length ? '' :
    '<div class="aviso '+cor+'"><b>'+titulo+' — '+itens.length+'</b><br>'+texto+'</div>'
    + '<div class="rolagem" style="margin-bottom:16px"><table><tr><th>Barramento / coordenada</th><th>'+coluna+'</th></tr>'
    + itens.map(p => '<tr><td class="barr">'+esc(p.barramento || (p.lat.toFixed(7)+', '+p.lon.toFixed(7)))+'</td>'
      + '<td>'+(p.novo ? 'ID_PONTO '+(p.seq||'—')+' · vai para o ANEXO B'
               : p.origem==='BDGD_FORA_DA_OS' ? 'COD_ID '+esc(p.cod_id||'—')+' · selecionar antes de subir foto'
               : esc(MOT[(rg[p.barramento]||{}).motivo] || 'descartado sem motivo registrado'))+'</td></tr>').join('')
    + '</table></div>';

  const alertaPend = !pendentes.length ? '' :
      '<div class="aviso erro"><b>Inventário incompleto — ' + pendentes.length + ' de ' + daOS
    + ' postes ainda pendentes.</b><br>Esses postes não foram visitados e <b>não entram na lista de exclusão</b>. '
    + 'Conclua o campo antes de ajustar a seleção no GEOSWEB, ou peça ao colaborador para descartá-los '
    + 'explicitamente se a rota já os dispensou.</div>';

  $('#listas').innerHTML = alertaPend +
      bloco('EXCLUIR da seleção', 'alerta',
        'Descartados em campo, com motivo registrado. Desmarque no GEOSWEB antes de fechar o projeto.',
        excluir, 'motivo')
    + bloco('INCLUIR na seleção', 'alerta',
        'Postes usados em campo que existem na base mas não estavam na OS. <b>O GEOSWEB só libera o campo de foto depois de selecionar</b> — faça isto antes de subir as imagens.',
        incluir, 'o que fazer')
    + bloco('CADASTRAR na concessionária', 'erro',
        'Não existem na base. Entram no ANEXO B com a coordenada como número do poste.',
        cadastrar, 'destino')
    + (!excluir.length && !incluir.length && !cadastrar.length && !pendentes.length
        ? '<div class="aviso ok">A rota saiu do campo igual à seleção do GEOSWEB. Nada a ajustar na plataforma.</div>' : '');
}
function csvRelatorio(){
  const inv = retorno, ps = inv.postes||[], rg = inv.registros||{};
  const st = b => (rg[b]||{}).status || 'pendente';
  const lin = [['ACAO','BARRAMENTO_OU_COORDENADA','COD_ID','ID_PONTO','LAT','LON','OBS'].join(';')];
  ps.forEach(p => {
    const s = st(p.barramento), usado = ['ok','divergente'].includes(s);
    let acao = null, obs = '';
    if (s==='descartado' && p.origem!=='BDGD_FORA_DA_OS' && !p.novo){
      acao='EXCLUIR'; obs = (rg[p.barramento]||{}).motivo || 'sem motivo registrado'; }
    else if (s==='pendente' && p.origem!=='BDGD_FORA_DA_OS' && !p.novo){
      acao='PENDENTE'; obs='NAO visitado em campo — nao desmarcar sem concluir o inventario'; }
    else if (usado && p.origem==='BDGD_FORA_DA_OS'){ acao='INCLUIR'; obs='selecionar no GEOSWEB para liberar o campo de foto'; }
    else if (usado && p.novo){ acao='CADASTRAR'; obs='não consta da base; vai ao ANEXO B'; }
    if (acao) lin.push([acao, p.barramento || (p.lat.toFixed(7)+', '+p.lon.toFixed(7)),
      p.cod_id||'', p.seq!=null?p.seq:'', String(p.lat).replace('.',','),
      String(p.lon).replace('.',','), obs].join(';'));
  });
  return '﻿' + lin.join('\r\n') + '\r\n';
}

/* ---------- ligações ---------- */
function solta(idDiv, idInput, aoReceber){
  const d = $(idDiv), i = $(idInput);
  d.onclick = () => i.click();
  d.ondragover = e => { e.preventDefault(); d.classList.add('sobre'); };
  d.ondragleave = () => d.classList.remove('sobre');
  d.ondrop = e => { e.preventDefault(); d.classList.remove('sobre');
    if (e.dataTransfer.files[0]) aoReceber(e.dataTransfer.files[0]); };
  i.onchange = () => { if (i.files[0]) aoReceber(i.files[0]); i.value=''; };
}
function marcar(idDiv, titulo, sub){
  const d = $(idDiv); d.classList.add('tem');
  d.innerHTML = '<b>'+esc(titulo)+'</b><div class="mini">'+sub+'</div>';
}
window.addEventListener('DOMContentLoaded', () => {
  $$('nav button').forEach(b => b.onclick = () => {
    $$('nav button').forEach(x=>x.classList.toggle('on', x===b));
    $$('.tela').forEach(s=>s.classList.toggle('on', s.id==='t-'+b.dataset.t));
  });

  solta('#sXlsx', '#fXlsx', async f => {
    try{
      const r = lerPlanilha(await f.arrayBuffer(), f.name);
      OS = r.os; tipoOS = r.tipoOS; postes = r.postes;
      marcar('#sXlsx', f.name, r.postes.length + ' postes · ' + r.linhas + ' linhas · <b>' + esc(r.tipoOS) + '</b>'
        + (r.coincidentes.length ? ' · <span style="color:var(--erro)">'+r.coincidentes.length+' par(es) coincidente(s) &lt; 1 m</span>' : ''));
      processar();
      toast(postes.length + ' postes lidos');
    }catch(e){ console.error(e); toast('Falha: ' + e.message, 6000); }
  });

  solta('#sMun', '#fMun', async f => {
    try{
      base = await lerMunicipio(f);
      $('#cMunNome').value = base.municipio;
      marcar('#sMun', base.municipio, base.postes.length.toLocaleString('pt-BR') + ' postes e torres da BDGD');
      processar();
    }catch(e){ console.error(e); toast('Falha: ' + e.message, 6000); }
  });

  $('#btnInverter').onclick = () => {
    postes.reverse(); postes.forEach((p,i)=>p.seq=i+1); pintarPreparar();
    toast('Sentido invertido');
  };
  $('#cRaio').onchange = () => { montarCinturao(); pintarPreparar(); };
  ['#cBairro','#cCep','#cMunNome'].forEach(id => {
    const e = $(id); if (e) e.onchange = () => { derivarEnderecos(); pintarPreparar(); };
  });
  $('#btnEnd').onclick = () => baixar(
    new Blob([csvEnderecos()], {type:'text/csv;charset=utf-8'}), nomeBase()+'_ENDERECOS.csv');

  $('#btnPacote').onclick = () => {
    const p = montarPacote();
    baixar(new Blob([JSON.stringify(p)], {type:'application/json'}), nomeBase()+'_PACOTE.json');
    $('#infoSaida').innerHTML = 'Pacote com <b>'+postes.length+'</b> postes da OS e <b>'+cinturao.length
      + '</b> do cinturão. Mande este arquivo ao colaborador e importe na aba Projeto do app.';
  };
  $('#btnKmz').onclick = () => {
    const kml = montarKml((OS||'projeto') + ' — projeto inicial', postes, true);
    baixar(zip([{nome:'doc.kml', dados:new TextEncoder().encode(kml)}]), nomeBase()+'_INICIAL.kmz');
  };

  solta('#sZip', '#fZip', async f => {
    try{
      const inv = await lerZip(f);
      marcar('#sZip', f.name, (inv.postes||[]).length + ' postes · pacote de ' + esc(inv.gerado_em||'—'));
      pintarRetorno(inv);
      if (inv.cfg && inv.cfg.os) $('#hdrOs').textContent = 'OS ' + inv.cfg.os;
    }catch(e){ console.error(e); toast('Falha: ' + e.message, 6000); }
  });
  $('#btnRelProj').onclick = () => baixar(
    new Blob([csvRelatorio()], {type:'text/csv;charset=utf-8'}),
    (retorno.cfg&&retorno.cfg.os ? retorno.cfg.os : 'OS') + '_AJUSTES_GEOSWEB.csv');
  $('#btnKmzVal').onclick = () => {
    const rg = retorno.registros||{};
    const us = (retorno.postes||[]).filter(p => ['ok','divergente'].includes((rg[p.barramento]||{}).status));
    const kml = montarKml(((retorno.cfg&&retorno.cfg.os)||'projeto') + ' — rota validada', us, true);
    baixar(zip([{nome:'doc.kml', dados:new TextEncoder().encode(kml)}]),
      ((retorno.cfg&&retorno.cfg.os)||'OS') + '_VALIDADO.kmz');
  };
});
