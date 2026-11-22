const $ = id => document.getElementById(id);

async function getJson(url) {
  const response = await fetch(url, {cache:'force-cache'});
  if (!response.ok) throw new Error(`Falha ao obter dados (${response.status})`);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message || 'Erro no serviço cartográfico');
  return json;
}
async function getArcgisItems(layerId, fields) {
  const base = 'https://sig.lneg.pt/server/rest/services/geoPortal/CAOP_DGT/MapServer';
  const features = [];
  let offset = 0;
  while (true) {
    const query = new URLSearchParams({
      where:'1=1', outFields:fields.join(','), returnGeometry:'true',
      outSR:'4326', f:'geojson', resultOffset:String(offset), resultRecordCount:'1000'
    });
    const page = await getJson(`${base}/${layerId}/query?${query}`);
    if (!Array.isArray(page.features)) throw new Error(`A camada ${layerId} não devolveu GeoJSON.`);
    features.push(...page.features);
    if (page.features.length < 1000 && !page.exceededTransferLimit) break;
    offset += page.features.length;
    if (!page.features.length) break;
  }
  return features;
}
function hashCode(value) {
  let hash = 0;
  for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 10;
}
function geometryCenter(geometry) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const scan = value => {
    if (Array.isArray(value) && typeof value[0] === 'number') {
      minX=Math.min(minX,value[0]); maxX=Math.max(maxX,value[0]);
      minY=Math.min(minY,value[1]); maxY=Math.max(maxY,value[1]);
    } else if (Array.isArray(value)) value.forEach(scan);
  };
  scan(geometry.coordinates);
  return Number.isFinite(minX) ? [(minX+maxX)/2,(minY+maxY)/2] : [-8,39.5];
}
function asFeature(feature, id, properties) {
  return {type:'Feature',id:String(id),properties:{oid:String(id),...properties},geometry:feature.geometry};
}
function groupedGeometry(features) {
  const coordinates = [];
  for (const feature of features) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') coordinates.push(g.coordinates);
    else if (g.type === 'MultiPolygon') coordinates.push(...g.coordinates);
  }
  return {type:'MultiPolygon',coordinates};
}
function addIslandFeatures(rawFeatures, firstCode, districtFeatures, municipalityFeatures, parishFeatures) {
  if (!rawFeatures.length) return;
  const islands = [...new Set(rawFeatures.map(f => f.properties?.Ilha).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt'));
  islands.forEach((island, islandIndex) => {
    const districtCode = String(firstCode + islandIndex).padStart(2,'0');
    const islandParishes = rawFeatures.filter(f => f.properties.Ilha === island);
    const municipalityNames = [...new Set(islandParishes.map(f => f.properties.Concelho).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt'));
    const districtGeometry = groupedGeometry(islandParishes);
    districtFeatures.push({type:'Feature',id:districtCode,properties:{code:districtCode,oid:districtCode,district:districtCode,name:island,center:false,label:geometryCenter(districtGeometry)},geometry:districtGeometry});
    municipalityNames.forEach((municipalityName, municipalityIndex) => {
      const municipalityCode = districtCode + String(municipalityIndex+1).padStart(2,'0');
      const members = islandParishes.filter(f => f.properties.Concelho === municipalityName).sort((a,b)=>String(a.properties.Freguesia).localeCompare(String(b.properties.Freguesia),'pt'));
      const municipalityGeometry = groupedGeometry(members);
      municipalityFeatures.push({type:'Feature',id:municipalityCode,properties:{code:municipalityCode,oid:municipalityCode,district:districtCode,municipality:municipalityCode,name:municipalityName,center:false,color:hashCode(municipalityCode)},geometry:municipalityGeometry});
      members.forEach((feature, parishIndex) => {
        const parishCode = municipalityCode + String(parishIndex+1).padStart(2,'0');
        parishFeatures.push(asFeature(feature,parishCode,{code:parishCode,oid:parishCode,district:districtCode,municipality:municipalityCode,name:feature.properties.Freguesia || 'Freguesia',center:false,color:hashCode(parishCode)}));
      });
    });
  });
}
async function loadAtlasData() {
  const [rawDistricts, rawMunicipalities, rawParishes] = await Promise.all([
    getArcgisItems(1,['DI','Distrito','OBJECTID']),
    getArcgisItems(2,['DICO','Concelho','Distrito','NUTSII','OBJECTID']),
    getArcgisItems(3,['DICOFRE','Freguesia','Municipio','Distrito','OBJECTID'])
  ]);
  const centralDistrictCodes = new Set(['01','05','06','09','10','18']);
  const districtFeatures = rawDistricts.map(feature => {
    const p = feature.properties, code = String(p.DI).padStart(2,'0');
    return asFeature(feature,code,{code,district:code,name:p.Distrito,center:centralDistrictCodes.has(code),label:geometryCenter(feature.geometry)});
  });
  const municipalityFeatures = rawMunicipalities.map(feature => {
    const p = feature.properties, code = String(p.DICO).padStart(4,'0'), district = code.slice(0,2);
    return asFeature(feature,code,{code,district,municipality:code,name:p.Concelho,center:p.NUTSII === 'Centro',color:hashCode(code)});
  });
  const centralMunicipalities = new Set(municipalityFeatures.filter(f=>f.properties.center).map(f=>f.id));
  const parishFeatures = rawParishes.map(feature => {
    const p = feature.properties, code = String(p.DICOFRE).padStart(6,'0'), municipality = code.slice(0,4), district = code.slice(0,2);
    return asFeature(feature,code,{code,district,municipality,name:p.Freguesia,center:centralMunicipalities.has(municipality),color:hashCode(code)});
  });
  const islandWarnings = [];
  const islandResults = await Promise.allSettled([
    getArcgisItems(5,['Freguesia','Concelho','Ilha','OBJECTID']),
    getArcgisItems(13,['Freguesia','Concelho','Ilha','OBJECTID'])
  ]);
  if (islandResults[0].status === 'fulfilled') addIslandFeatures(islandResults[0].value,31,districtFeatures,municipalityFeatures,parishFeatures);
  else islandWarnings.push('Madeira');
  if (islandResults[1].status === 'fulfilled') addIslandFeatures(islandResults[1].value,41,districtFeatures,municipalityFeatures,parishFeatures);
  else islandWarnings.push('Açores');
  const data = {
    district:{type:'FeatureCollection',features:districtFeatures},
    municipality:{type:'FeatureCollection',features:municipalityFeatures},
    parish:{type:'FeatureCollection',features:parishFeatures},
    land:{type:'FeatureCollection',features:[]},
    tiles:{}
  };
  return {data,islandWarnings};
}

(async () => {
  try {
    $('notice').textContent = 'A carregar os limites administrativos oficiais de Portugal…';
    $('notice').hidden = false;
    const result = await loadAtlasData();
    runAtlas(result.data);
    if (result.islandWarnings.length) announce(`Não foi possível carregar a informação de ${result.islandWarnings.join(' e ')}. O continente está disponível.`);
    else announce('Dados administrativos CAOP carregados. Usa os botões e a lista para explorar Portugal.');
  } catch (error) {
    console.error(error);
    $('notice').textContent = 'Não foi possível carregar o Atlas. Verifica a ligação à Internet e tenta novamente.';
    $('notice').hidden = false;
  }
})();

function runAtlas(data) {
const layers = ['district', 'municipality', 'parish'];
const names = {district:'distrito', municipality:'concelho', parish:'freguesia'};
const plurals = {district:'Distritos', municipality:'Concelhos', parish:'Freguesias'};
const collections = {district:data.district, municipality:data.municipality, parish:data.parish};
const lookup = Object.fromEntries(layers.map(layer => [layer, new Map(collections[layer].features.map(f => [f.id, f]))]));
const count = {district:new Map(), municipality:new Map()};
for (const {properties:p} of data.parish.features) {
  for (const layer of ['district','municipality']) {
    const id = p[layer];
    count[layer].set(id, (count[layer].get(id) || 0) + 1);
  }
}
const isIsland = id => Number(id) > 18;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const national = [[-9.62,36.88],[-6.16,42.17]];
const islandBounds = {azores:[[-31.35,36.9],[-24.9,40.03]], madeira:[[-17.4,32.37],[-16.2,33.18]]};
const compact = matchMedia('(max-width: 680px)');
const centerMunicipalities = data.municipality.features.filter(f=>f.properties.center);
const districtColors = {
  '01':'#e57d36','02':'#538bc9','03':'#51934b','04':'#59b8b3','05':'#785ab5','06':'#599ce0',
  '07':'#48af9c','08':'#c28845','09':'#d05978','10':'#f0c953','11':'#8956ba','12':'#e97c41',
  '13':'#9873ce','14':'#408b6b','15':'#e25362','16':'#dcad35','17':'#cf5989','18':'#78a744'
};
for (const feature of data.district.features) {
  feature.properties.shade = districtColors[feature.id] || '#4ca49f';
  feature.properties.total = count.district.get(feature.id) || 0;
}
const centerOverlay = {type:'FeatureCollection',features:centerMunicipalities.map(f=>({
  ...f, properties:{...f.properties,...Object.fromEntries(['shade','total'].map(key=>[key,lookup.district.get(f.properties.district).properties[key]]))}
}))};
const palette = ['#70a58c','#f1bf70','#97adb9','#d58e79','#a4b37d','#80b5aa','#b39ab7','#e6a973','#8fa9cc','#d3c37e'];
let state = {layer:'district',district:null,municipality:null,parish:null,region:null};
let reliefOn = true;
let pulseFrame = 0;
let selectedLift = 0;
const heightStops = [[4.7,0],[5.6,1],[7.2,0.62],[10,0.14],[13,0.018]];
let raised = [];
let map, ready = false, tourId = 0, markers = [], hovered = null;

function boundsOf(features) {
  const bounds = new maplibregl.LngLatBounds();
  for (const item of features) {
    const polygons = item.geometry.type === 'Polygon' ? [item.geometry.coordinates] : item.geometry.coordinates;
    for (const polygon of polygons) for (const point of polygon[0]) bounds.extend(point);
  }
  return bounds;
}
function padding() {
  const panel = document.querySelector('.panel').getBoundingClientRect();
  return compact.matches
    ? {left:28,right:42,top:119,bottom:Math.ceil(panel.height)+38}
    : {left:Math.ceil(panel.right)+48,right:78,top:104,bottom:42};
}
function frame(bounds, options = {}) {
  if (!ready) return;
  map.stop();
  map.fitBounds(bounds, {padding:padding(),duration:reduced.matches?0:1600,maxZoom:13,...districtView(),essential:false,...options});
}
function districtView() {
  return reliefOn && state.layer==='district' ? {pitch:43,bearing:-12} : {pitch:0,bearing:0};
}
function animateDistrict() {
  cancelAnimationFrame(pulseFrame);
  selectedLift=0;
  raised.forEach(feature=>map.removeFeatureState(feature,'lift'));
  const districts = state.region==='center' ? centerOverlay.features : data.district.features;
  const source = state.region==='center' ? 'center' : 'district';
  raised = districts.filter(f=>f.properties.district===state.district && state.layer==='district' && reliefOn)
    .map(f=>({source,id:f.properties.oid}));
  if (!raised.length) return;
  const start = performance.now();
  function rise(now) {
    const t = reduced.matches ? 1 : Math.min(1,(now-start)/580);
    const lift = 1 - (1-t)**3 * Math.cos(t*Math.PI*2);
    selectedLift=lift;
    raised.forEach(feature=>map.setFeatureState(feature,{lift}));
    positionLabels();
    if (t<1) pulseFrame=requestAnimationFrame(rise);
  }
  rise(start);
}
function announce(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
function featureList() {
  return collections[state.layer].features.filter(({id,properties:p}) => {
    if (state.region === 'center' && !p.center) return false;
    if (state.region === 'azores' && !(+id.slice(0,2) >= 41)) return false;
    if (state.region === 'madeira' && !(+id.slice(0,2) >= 31 && +id.slice(0,2) < 41)) return false;
    if (!state.region && !state.district && isIsland(id.slice(0,2))) return false;
    if (state.layer !== 'district' && state.district && p.district !== state.district) return false;
    return state.layer !== 'parish' || !state.municipality || p.municipality === state.municipality;
  });
}
function render() {
  const layer = state.layer;
  const id = state[layer];
  const selected = lookup[layer].get(id);
  const parent = lookup.municipality.get(state.municipality) || lookup.district.get(state.district);
  const features = featureList();
  const region = {center:'Zona Centro',azores:'Açores',madeira:'Madeira'}[state.region];
  $('scope').textContent = selected ? plurals[layer] : parent?.properties.name || region || 'Portugal continental';
  $('heading').textContent = selected?.properties.name || region || (parent ? plurals[layer] : 'Portugal em 3D');
  $('summary').textContent = layer === 'parish' && selected
    ? lookup.municipality.get(selected.properties.municipality).properties.name
    : selected && layer === 'district' ? data.municipality.features.filter(f=>f.properties.district===id).length+' concelhos neste território.'
    : selected ? 'Explora os limites desta divisão no mapa.'
    : layer === 'municipality' && state.district ? features.length+' concelhos nesta vista.'
    : layer === 'district' && !region ? 'Do globo ao mapa de Portugal. Escolhe um distrito para começar.' : 'Seleciona uma divisão no mapa ou na lista.';
  const quantity = selected
    ? layer === 'parish' ? count.municipality.get(state.municipality) : count[layer].get(id) || 0
    : layer === 'municipality' && state.district ? features.reduce((total,f)=>total+(count.municipality.get(f.id)||0),0)
    : features.length;
  const unit = selected || (layer === 'municipality' && state.district) ? 'Freguesias' : plurals[layer];
  $('metric').hidden = quantity == null;
  $('count').textContent = quantity == null ? '' : quantity.toLocaleString('pt-PT');
  $('unit').textContent = layer === 'parish' && selected ? (quantity===1?'Freguesia no concelho':'Freguesias no concelho') : quantity === 1 ? names[layer === 'district' && !selected ? 'district' : layer === 'municipality' && !selected && !state.district ? 'municipality' : 'parish'] : unit;
  $('place-label').textContent = 'Escolher ' + (region && region !== 'Zona Centro' && layer === 'district' ? 'ilha' : names[layer]);
  const select = $('places');
  const options = [...features].sort((a,b) => a.properties.name.localeCompare(b.properties.name,'pt')).map(f => new Option(f.properties.name,f.id));
  select.replaceChildren(new Option('Selecionar no mapa ou na lista…',''),...options);
  select.value = id || '';
  $('back').hidden = !selected && !parent;
  $('drill').hidden = !selected || layer === 'parish';
  $('drill').textContent = layer === 'district' ? 'Ver concelhos →' : 'Ver freguesias →';
  $('islands').hidden = Boolean(state.region);
  $("madeira").hidden = Boolean(state.region);
  $('country').textContent = 'Portugal';
  document.querySelectorAll('[data-layer]').forEach(button => button.setAttribute('aria-pressed',button.dataset.layer === layer));
  $('relief-note').hidden = layer !== 'district' || !reliefOn;
  $('tilt').setAttribute('aria-pressed',layer === 'district' && reliefOn);
  if (!ready) return;
  clearHover();
  const centerDistricts = state.region === 'center' && layer === 'district';
  map.setLayoutProperty('center-fill','visibility',centerDistricts ? 'visible' : 'none');
  map.setLayoutProperty('center-line','visibility',centerDistricts ? 'visible' : 'none');
  for (const kind of layers) {
    const codes = kind === layer ? features.map(f=>f.id) : [];
    const filter = values => ['in',['get','code'],['literal',values]];
    map.setFilter(kind+'-fill',filter(centerDistricts ? [] : codes));
    map.setFilter(kind+'-line',filter(codes));
    map.setFilter(kind+'-selected',['==',['get','code'],kind === layer && id ? id : '']);
  }
  map.setLayoutProperty('district-relief','visibility',layer==='district' && !centerDistricts && reliefOn ? 'visible' : 'none');
  map.setLayoutProperty('center-relief','visibility',centerDistricts && reliefOn ? 'visible' : 'none');
  map.setFilter('district-relief',['in',['get','code'],['literal',features.map(f=>f.id)]]);
  animateDistrict();
  updateMarkers();
}
function activeFill() {
  if (state.layer !== 'district') return [state.layer+'-fill'];
  const source = state.region === 'center' ? 'center' : 'district';
  return reliefOn ? [source+'-relief',source+'-fill'] : [source+'-fill'];
}
function selectPlace(layer,id) {
  const item = lookup[layer].get(id);
  if (!item) return;
  tourId++;
  state.layer = layer;
  state.district = id.slice(0,2);
  state.municipality = layer === 'district' ? null : id.slice(0,4);
  state.parish = layer === 'parish' ? id : null;
  render();
  if (layer === 'district' && reliefOn && ready && map.getZoom()>=4.7) {
    if (map.getPitch()<20) map.easeTo({...districtView(),duration:reduced.matches?0:650});
    return;
  }
  const bounds = state.region === 'center' && layer === 'district'
    ? boundsOf(data.municipality.features.filter(f=>f.properties.center && f.properties.district === id))
    : boundsOf([item]);
  frame(bounds, layer==='parish' ? {pitch:30} : {});
}
function setLayer(layer) {
  tourId++;
  const old = state.layer;
  state.layer = layer;
  if (layer !== 'parish') state.parish = null;
  if (layer === 'district' || (layer === 'municipality' && old === 'district')) state.municipality = null;
  render();
  const target = state[layer] && lookup[layer].get(state[layer]);
  const features = featureList();
  if (target && state.region !== 'center') frame(boundsOf([target]));
  else if (features.length && (state.region || state.district || state.municipality)) frame(boundsOf(features));
  else frame(national);
}
function focusRegion(region) {
  tourId++;
  state = {layer:'district',district:null,municipality:null,parish:null,region};
  render();
  frame(region === 'center' ? boundsOf(data.municipality.features.filter(f=>f.properties.center)) : islandBounds[region] || national);
}
function worldTour() {
  const ticket = ++tourId;
  state = {layer:'district',district:null,municipality:null,parish:null,region:null};
  render();
  if (!ready) return;
  map.stop();
  if (reduced.matches) { frame(national); return; }
  map.jumpTo({center:[-43,16],zoom:compact.matches?1:1.22,pitch:0,bearing:0,padding:{left:0,right:0,top:0,bottom:0}});
  setTimeout(() => {
    if (ticket !== tourId) return;
    const view = districtView();
    const camera = map.cameraForBounds(national,{padding:padding(),bearing:view.bearing,maxZoom:8});
    if (camera) map.flyTo({...camera,...view,duration:4900,curve:1.46});
  },850);
}
function clearHover() {
  if (hovered) map.removeFeatureState(hovered,'hover');
  hovered = null;
  if (map) map.getCanvas().style.cursor = '';
}
const landmarks = [
  ['OCEANO ATLÂNTICO',[-11.1,38.7],'ocean',4,9],
  ['ESPANHA',[-5.7,40.2],'country',4.7,8],
  ['AÇORES',[-27.4,39.8],'country',3,7.5],
  ['MADEIRA',[-16.85,32.41],'country',4,8]
];
function labelPoint(location, feature) {
  const zoom = map.getZoom();
  const ceiling = heightStops.findIndex(([stop])=>stop>=zoom);
  const scale = ceiling<0 ? heightStops.at(-1)[1] : ceiling===0 ? 0 : (() => {
    const [from,a]=heightStops[ceiling-1];
    const [to,b]=heightStops[ceiling];
    return a+(b-a)*(zoom-from)/(to-from);
  })();
  const bump = state.district===feature.properties.district ? 29000*selectedLift : 0;
  const height = (3200+feature.properties.total*230+bump)*scale;
  return map.transform.locationToScreenPoint(location,{getElevationForLngLatZoom:()=>height});
}
function labelOffset(marker, feature) {
  const location = marker.getLngLat();
  const ground = map.project(location);
  const top = labelPoint(location,feature);
  marker.setOffset([top.x-ground.x,top.y-ground.y]);
}
function updateMarkers() {
  if (!ready) return;
  markers.forEach(({marker})=>marker.remove());
  const zoom = map.getZoom();
  const labels = [];
  if (state.layer === 'district' && zoom >= 5.3) {
    const places = featureList().sort((a,b)=>Number(b.id===state.district)-Number(a.id===state.district));
    for (const f of places) {
      if (!f.properties.label) continue;
      const label = reliefOn ? f.properties.name+' · '+f.properties.total : f.properties.name;
      labels.push([label,f.properties.label,'',f]);
    }
  }
  labels.push(...landmarks.filter(([, , ,min,max])=>zoom>=min && zoom<=max).map(([name,point,type])=>[name,point,type]));
  const occupied = [];
  markers = [];
  for (const [name,point,type,feature] of labels) {
    const projected = feature && reliefOn ? labelPoint(maplibregl.LngLat.convert(point),feature) : map.project(point);
    const width = name.length * (type ? 7.3 : 5.8) + 6;
    const bounds = [projected.x-width/2, projected.y-8, projected.x+width/2, projected.y+8];
    if (occupied.some(b=>b[0]<bounds[2] && b[2]>bounds[0] && b[1]<bounds[3] && b[3]>bounds[1])) continue;
    occupied.push(bounds);
    const el = document.createElement('span');
    el.textContent = name;
    el.className = 'place ' + type;
    const marker = new maplibregl.Marker({element:el,occludedOpacity:0}).setLngLat(point).addTo(map);
    if (feature && reliefOn) labelOffset(marker,feature);
    markers.push({marker,feature});
  }
}
function positionLabels() {
  if (state.layer==='district' && reliefOn) {
    for (const {marker,feature} of markers) if (feature) labelOffset(marker,feature);
  }
}
document.querySelectorAll('[data-layer]').forEach(button=>button.onclick=()=>setLayer(button.dataset.layer));
$('places').onchange = e=> { if(e.target.value) selectPlace(state.layer,e.target.value); };
$('drill').onclick = ()=>setLayer(layers[layers.indexOf(state.layer)+1]);
$('back').onclick = ()=>{
  if (state.layer === 'parish' && state.municipality) setLayer('municipality');
  else if (state.layer !== 'district') setLayer('district');
  else focusRegion(state.region);
};
$('center').onclick = ()=>focusRegion('center');
$('country').onclick = ()=>focusRegion(null);
$('tour').onclick = worldTour;
$('islands').onclick = ()=>focusRegion('azores');
$('plus').onclick = ()=>{tourId++; if (ready) map.zoomIn();};
$('minus').onclick = ()=>{tourId++; if (ready) map.zoomOut();};
$('north').onclick = ()=>{tourId++; if (ready) map.easeTo({bearing:0,pitch:0});};
$('tilt').onclick = ()=>{
  tourId++;
  if (!ready) return;
  const duration = reduced.matches?0:750;
  if (state.layer==='district') {
    reliefOn = !reliefOn;
    render();
    map.easeTo({...districtView(),duration});
  } else {
    const pitch = map.getPitch()>10 ? 0 : 48;
    $('tilt').setAttribute('aria-pressed',Boolean(pitch));
    map.easeTo({pitch,bearing:pitch ? -22 : 0,duration});
  }
};
const madeira = document.createElement('button');
madeira.id='madeira';
madeira.textContent='Madeira';
madeira.onclick=()=>focusRegion('madeira');
$('islands').textContent='Açores';
$('islands').after(madeira);
render();
try {
  const areaColor = ['match',['get','color'],...palette.flatMap((color,i)=>[i,color]),'#78a993'];
  const districtColor = ['get','shade'];
  const styleLayers = [
    {id:'ocean',type:'background',paint:{'background-color':['interpolate',['linear'],['zoom'],2.2,'#142936',4.8,'#a8c9cd']}},
    {id:'land',type:'fill',source:'land',paint:{'fill-color':'#e7e9d8','fill-outline-color':'#b4c3ae'}},
    {id:'satellite',type:'raster',source:'satellite',paint:{'raster-opacity':1,'raster-fade-duration':0}},
    {id:'context',type:'fill',source:'district',paint:{'fill-color':'#cfdcc6','fill-opacity':0.65}},
    {id:'center-fill',type:'fill',source:'center',layout:{visibility:'none'},paint:{'fill-color':districtColor,'fill-opacity':['case',['boolean',['feature-state','hover'],false],0.95,0.78]}},
    {id:'center-line',type:'line',source:'center',layout:{visibility:'none'},paint:{'line-color':'#326957','line-opacity':0.24,'line-width':0.65}}
  ];
  for (const layer of layers) {
    styleLayers.push(
      {id:layer+'-fill',type:'fill',source:layer,filter:['==',['get','code'],''],paint:{
        'fill-color':layer==='district'?districtColor:areaColor,
        'fill-opacity':['case',['boolean',['feature-state','hover'],false],0.94,layer==='district'?0.76:0.63]
      }},
      {id:layer+'-line',type:'line',source:layer,filter:['==',['get','code'],''],paint:{'line-color':'#345a50','line-opacity':0.63,'line-width':layer==='district'?1.05:0.65}},
      {id:layer+'-selected',type:'line',source:layer,filter:['==',['get','code'],''],paint:{'line-color':'#173e35','line-width':3}}
    );
  }
  for (const source of ['district','center']) {
    const meters = ['+',3200,['*',['get','total'],230],['*',29000,['coalesce',['feature-state','lift'],0]]];
    styleLayers.push({
      id:source+'-relief',type:'fill-extrusion',source,minzoom:4.7,layout:{visibility:'none'},
      paint:{
        'fill-extrusion-color':['case',['>', ['coalesce',['feature-state','lift'],0],0.1],'#fff0b0',districtColor],
        'fill-extrusion-height':['interpolate',['linear'],['zoom'],...heightStops.flatMap(([stop,scale])=>[stop,['*',meters,scale]])],
        'fill-extrusion-opacity':1,'fill-extrusion-vertical-gradient':true
      }
    });
  }
  const sources = Object.fromEntries(layers.map(layer=>[layer,{type:'geojson',data:collections[layer],promoteId:'oid',tolerance:layer==='parish'?0.16:0.28}]));
  sources.land = {type:'geojson',data:data.land,tolerance:0.6};
  sources.center = {type:'geojson',data:centerOverlay,promoteId:'oid'};
  sources.satellite = {type:'raster',tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],tileSize:256,maxzoom:18,attribution:'Tiles © Esri'};
  map = new maplibregl.Map({
    container:'map',center:[-43,16],zoom:compact.matches?1:1.22,maxZoom:16,maxPitch:65,renderWorldCopies:false,attributionControl:true,
    style:{version:8,projection:{type:'globe'},sky:{'sky-color':'#132c3c','horizon-color':'#86b0bb','fog-color':'#c8d9d7','fog-ground-blend':0.03,'horizon-fog-blend':0.14,'sky-horizon-blend':0.2,'atmosphere-blend':['interpolate',['linear'],['zoom'],0,0.65,5,0]},sources,layers:styleLayers}
  });
  map.on('load',()=>{ready=true;render();worldTour();});
  map.on('moveend',updateMarkers);
  map.on('move',positionLabels);
  map.on('movestart',e=>{if(e.originalEvent) tourId++;});
  map.on('mousemove',e=>{
    if (!ready) return;
    const hit = map.queryRenderedFeatures(e.point,{layers:activeFill()})[0];
    if (hovered?.id === hit?.id && hovered?.source === hit?.source) return;
    clearHover();
    if (!hit) return;
    hovered = {source:hit.source,id:hit.id};
    map.setFeatureState(hovered,{hover:true});
    map.getCanvas().style.cursor = 'pointer';
  });
  map.getCanvas().addEventListener('mouseleave',clearHover);
  map.on('click',e=>{
    if (!ready) return;
    const hit = map.queryRenderedFeatures(e.point,{layers:activeFill()})[0];
    if (hit) selectPlace(state.layer,hit.source === 'center' ? hit.properties.district : hit.properties.code);
  });
} catch (error) {
  announce('O mapa 3D precisa de um navegador com WebGL ativo. Podes continuar a consultar as divisões e as contagens na lista.');
}

}