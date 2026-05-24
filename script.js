Chart.register(ChartDataLabels); 

let db = [];
let map, markers, userMarker;
let charts = {}; 

// Pagination State Variables
let currentFilteredData = [];
let currentPage = 1;
const ITEMS_PER_PAGE = 50; 

const PH_CENTER = [12.8797, 121.7740];
const API_URL = 'https://sheetlabs.com/LA25/LIGTAS_LSDB_WEB_APIv2'; 

function init() {
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Esri' });
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: 'OSM' });

    map = L.map('map', { center: PH_CENTER, zoom: 5, layers: [sat], zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const lyProvinces = L.layerGroup();
    const lyRegions = L.layerGroup();
    const lyFaults = L.layerGroup();
    markers = L.layerGroup().addTo(map);

    ['provinces', 'regions', 'faults'].forEach((key, i) => {
        const colors = ['red', 'yellow', 'green'];
        fetch(`https://raw.githubusercontent.com/Gabzrock/LIGTASAGADEWSV3/refs/heads/main/uRIL_AWS_${key === 'provinces' ? 'High' : key === 'regions' ? 'Moderate' : 'Low'}_Susceptibility.geojson`)
            .then(r => r.json())
            .then(data => L.geoJson(data, { style: { color: colors[i], fillOpacity: 0.3 } }).addTo(i === 0 ? lyProvinces : i === 1 ? lyRegions : lyFaults));
    });

    L.control.layers({ "Satellite": sat, "OSM": osm }, { "Markers": markers, "MGB-High": lyProvinces, "MGB-Med": lyRegions, "MGB-Low": lyFaults }).addTo(map);

    map.on('moveend', () => {
        const extToggle = document.getElementById('fExtent');
        if (extToggle && extToggle.checked) filter(); 
    });

    connectRegistry();
}

async function connectRegistry() {
    setStatus('SYNCING DATA...', 'warning');
    try {
        const res = await fetch(API_URL);
        let raw = await res.json();
        
        db = raw.map(i => ({
            ...i,
            lat: parseFloat(i.Latitude) || null,
            lng: parseFloat(i.Longitude) || null,
            deaths: parseInt(i.DEATHS) || 0,
            year: i.Year ? String(i.Year).trim() : (i.YYYYMMDD ? String(i.YYYYMMDD).substring(0, 4) : 'Unknown')
        }));

        db.sort((a, b) => new Date(b.YYYYMMDD || 0) - new Date(a.YYYYMMDD || 0));
        setStatus('SYSTEM ONLINE', 'online');
        initFilters();
        filter();
    } catch (e) {
        setStatus('CONNECTION FAILED', 'error');
    }
}

function toggleFilters() {
    const fc = document.getElementById('filterControls');
    fc.classList.toggle('hidden-view');
    setTimeout(() => map.invalidateSize(), 350);
}

function initFilters() {
    document.getElementById('fY').innerHTML = `<option value="1">Past 1 Year</option><option value="2">Past 2 Years</option><option value="3">Past 3 Years</option><option value="all">All Time</option>`;
    document.getElementById('q').addEventListener('input', filter);
    ['fY', 'fR'].forEach(id => document.getElementById(id).addEventListener('change', () => { updateDropdownOptions(); filter(); }));
    ['fP', 'fT'].forEach(id => document.getElementById(id).addEventListener('change', filter));
    updateDropdownOptions();
}

function updateDropdownOptions() {
    const timeFiltered = getFilteredData(true);
    const reg = document.getElementById('fR').value;
    
    populateDropdown('fR', 'REGION', 'All Regions', timeFiltered);
    populateDropdown('fT', 'LANDSLIDE', 'All Triggers', timeFiltered);
    populateDropdown('fP', 'PROVINCE', 'All Provinces', reg ? timeFiltered.filter(i => i.REGION === reg) : timeFiltered);
}

function populateDropdown(id, key, label, data) {
    const el = document.getElementById(id);
    const cur = el.value;
    const items = [...new Set(data.map(i => i[key]))].filter(v => v && v !== 'Unknown').sort();
    el.innerHTML = `<option value="">${label}</option>` + items.map(v => `<option value="${v}">${v}</option>`).join('');
    if (items.includes(cur)) el.value = cur;
}

function getFilteredData(onlyTime = false) {
    const tF = document.getElementById('fY').value;
    const now = new Date();
    const cutoff = tF === '1' ? new Date(now.getFullYear()-1,0) : tF === '2' ? new Date(now.getFullYear()-2,0) : tF === '3' ? new Date(now.getFullYear()-3,0) : new Date(0);
    
    let res = db.filter(i => new Date(i.YYYYMMDD || 0) >= cutoff || tF === 'all');
    if (onlyTime) return res;
    
    const q = document.getElementById('q').value.toLowerCase();
    const fExtent = document.getElementById('fExtent');
    const applyExtent = fExtent ? fExtent.checked : false;
    let bounds = null;
    if (applyExtent) bounds = map.getBounds();

    return res.filter(i => 
        (!applyExtent || (i.lat !== null && i.lng !== null && bounds.contains([i.lat, i.lng]))) &&
        (!q || Object.values(i).join(' ').toLowerCase().includes(q)) &&
        (!document.getElementById('fR').value || i.REGION === document.getElementById('fR').value) &&
        (!document.getElementById('fP').value || i.PROVINCE === document.getElementById('fP').value) &&
        (!document.getElementById('fT').value || i.LANDSLIDE === document.getElementById('fT').value)
    );
}

// --- PAGINATION & LIST RENDERER ---
function filter() {
    currentFilteredData = getFilteredData();
    document.getElementById('rec-count').innerText = `${currentFilteredData.length} RECORDS MATCHED`;
    
    currentPage = 1; // Reset to page 1 whenever filters change
    renderPaginatedList();
    buildCharts(currentFilteredData);
}

function changePage(direction) {
    currentPage += direction;
    document.getElementById('feed').scrollTop = 0; // Scroll back to top
    renderPaginatedList();
}

function renderPaginatedList() {
    markers.clearLayers();
    
    // Always render ALL filtered markers to the map (gives the geographic overview)
    currentFilteredData.forEach(i => {
        if(i.lat) L.circleMarker([i.lat, i.lng], {radius:8, fillColor:i.deaths>0?'#ef4444':'#f59e0b', color:'#fff', fillOpacity:0.9}).addTo(markers).on('click', () => openReport(i));
    });

    const feedEl = document.getElementById('feed');
    const paginationEl = document.getElementById('paginationControls');

    if (currentFilteredData.length === 0) {
        feedEl.innerHTML = '<div style="padding:40px; text-align:center; font-size:18px; font-weight:bold; color:#94a3b8; width:100%;">No records found. Adjust your filters or map.</div>';
        paginationEl.innerHTML = '';
        return;
    }

    // Pagination Logic
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const pageData = currentFilteredData.slice(startIndex, endIndex);
    const totalPages = Math.ceil(currentFilteredData.length / ITEMS_PER_PAGE);

    // Render List Items
    feedEl.innerHTML = pageData.map(i => {
        const safeStringify = JSON.stringify(i).replace(/'/g, "&apos;").replace(/"/g, "&quot;");
        return `
            <div class="list-row ${i.deaths > 0 ? 'high-risk' : ''}" onclick="openReport(${safeStringify})">
                <div class="lr-id">${i.LSID || 'N/A'}</div>
                <div class="lr-date">${i.YYYYMMDD || 'Unknown'}</div>
                <div class="lr-col lr-loc">${i.MUNICIPALITY || 'Unknown'}, ${i.PROVINCE || 'Unknown'}</div>
                <div class="lr-col"><span class="lr-trig">${i.LANDSLIDE || 'Registry Entry'}</span></div>
                ${i.deaths > 0 ? `<div class="lr-badge">💀 ${i.deaths} FATALITIES</div>` : ''}
            </div>
        `;
    }).join('');

    // Render Pagination Buttons
    paginationEl.innerHTML = `
        <button class="btn btn-sec" ${currentPage === 1 ? 'disabled' : ''} onclick="changePage(-1)" style="width: auto; padding: 8px 16px;">◀ Prev</button>
        <span style="font-weight: 900; font-size: 14px; color: var(--primary);">Page ${currentPage} of ${totalPages}</span>
        <button class="btn btn-sec" ${currentPage === totalPages ? 'disabled' : ''} onclick="changePage(1)" style="width: auto; padding: 8px 16px;">Next ▶</button>
    `;
}

// --- UX LOGIC & ANIMATIONS ---
function flyToLocation(i) {
    if (i.lat !== null && i.lng !== null) {
        closeModal();
        const mapDiv = document.getElementById('map');
        if (mapDiv.classList.contains('hidden-view')) toggleView('split');
        
        map.flyTo([i.lat, i.lng], 14, { animate: true, duration: 1.5 });
        const ping = L.circleMarker([i.lat, i.lng], { radius: 30, color: '#10b981', fillColor: '#10b981', fillOpacity: 0.3, weight: 3 }).addTo(map);
        setTimeout(() => { if (map.hasLayer(ping)) map.removeLayer(ping); }, 3000);
    } else {
        alert("Cannot locate: This record does not have valid GPS coordinates.");
    }
}

function toggleView(viewType) {
    const mapDiv = document.getElementById('map');
    const feedDiv = document.getElementById('feed');
    const pagDiv = document.getElementById('paginationControls');
    const btn = document.getElementById('toggleViewBtn');

    if (viewType === 'map') {
        mapDiv.classList.remove('hidden-view'); mapDiv.classList.add('full-map'); feedDiv.classList.add('hidden-view'); pagDiv.classList.add('hidden-view');
        btn.innerText = 'Expand Data List'; btn.style.background = '#1e293b'; btn.onclick = () => toggleView('list');
    } else if (viewType === 'list') {
        mapDiv.classList.add('hidden-view'); mapDiv.classList.remove('full-map'); feedDiv.classList.remove('hidden-view'); pagDiv.classList.remove('hidden-view');
        btn.innerText = 'Show Split View'; btn.style.background = '#10b981'; btn.onclick = () => toggleView('split');
    } else {
        mapDiv.classList.remove('hidden-view', 'full-map'); feedDiv.classList.remove('hidden-view'); pagDiv.classList.remove('hidden-view');
        btn.innerText = 'Expand Map'; btn.style.background = 'var(--accent)'; btn.onclick = () => toggleView('map');
    }
    if (!mapDiv.classList.contains('hidden-view')) setTimeout(() => map.invalidateSize(), 300);
}

// --- REPORT MODAL ---
function openReport(i) {
    const b = document.getElementById('m-body');
    const row = (l, v) => `<div class="field-grp"><div class="f-lbl">${l}</div><div class="f-val">${v || '—'}</div></div>`;
    const safeStringify = JSON.stringify(i).replace(/'/g, "&apos;").replace(/"/g, "&quot;");
    
    b.innerHTML = `
        <div style="background:#f1f5f9; padding:25px; border-radius:10px; margin-bottom:25px; border:2px solid #e2e8f0; display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:15px;">
            <div>
                <h2 style="margin:0; color:var(--primary); font-size:26px; font-weight:900;">${i.MUNICIPALITY || 'Unknown Area'} Landslide</h2>
                <div style="font-size:15px; font-weight:700; color:#64748b; margin-top:8px;">
                    ${i.PROVINCE || '—'} | ${i.REGION || '—'} | Date: ${i.YYYYMMDD || 'Unknown'} at ${i['12HOURFO'] || '—'} ${i.AMPM || ''}
                </div>
            </div>
            ${(i.lat !== null && i.lng !== null) ? 
                `<button class="btn btn-main no-print" style="white-space:nowrap;" onclick="flyToLocation(${safeStringify})">📍 Locate on Map</button>` 
                : '<span style="color:#ef4444; font-size:14px; font-weight:900; align-self:center; background:#fef2f2; padding:8px 12px; border-radius:6px; border:2px solid #fecaca;">NO GPS DATA</span>'}
        </div>

        <div class="sec-title">A. Spatial Geography</div>
        <div class="grid-2">
            ${row('Coordinates', (i.lat !== null && i.lng !== null) ? `${i.lat}, ${i.lng}` : 'Unmapped')} ${row('Precision', i.LATLONGR)}
            ${row('Barangay', i.BARANGAY)} ${row('Sitio', i.SITIO)}
            ${row('Elevation', i.ELEVATION)} ${row('Accessibility', i.ACCESIBILITY)}
            ${row('Topography/Location Details', i.LSLOCDETAILS)}
        </div>

        <div class="sec-title">B. Technical Characteristics</div>
        <div class="grid-2">
            ${row('Trigger Event', i.LANDSLIDE)} ${row('Classification', i.LANDSLID1)}
            ${row('Dimensions (H x L x W)', `${i.HeightTaas || 0}m x ${i.LengthHaba || 0}m x ${i.WidthLapad || 0}m`)}
            ${row('Land Cover', i.LANDCOVER)}
            ${row('AWS Data Link', i.AWSDATA)} ${row('Other Land Features', i.OTHERLAND)}
        </div>
        <div style="margin-top:15px;">${row('Additional Information', i.OTHERINFO)}</div>

        <div class="sec-title">C. Casualties & Impact</div>
        <div class="grid-2">
            ${row('DEATHS', i.deaths)} ${row('INJURED', i.injured)}
            ${row('Displaced Persons', i.displaced)} ${row('Evacuation Site', i.EVACUATIONSITE)}
        </div>

        <div class="sec-title">D. Verification & Sources</div>
        <div class="grid-2">
            ${row('General Source', i.GENERALSOURCES)} ${row('Specific Source', i.SPECIFICSOURCE)}
            ${row('External Link', i.SOURCELINK ? `<a href="${i.SOURCELINK}" target="_blank" style="color:var(--accent); text-decoration:underline;">Open Official Source</a>` : '—')}
            ${row('Date/Time Recorded', i.DATETIMERECORDED)}
        </div>
        
        <div style="margin-top:20px; padding:15px; background:#fff7ed; border-radius:8px; border:2px solid #ffedd5;">
            ${row('Analyst/Encoder Remarks', i.DATETIMEREMARKS)}
            <div style="font-size:12px; font-weight:800; color:#94a3b8; margin-top:10px;">Encoded by: ${i.ENCODERNAME || 'N/A'} | Timestamp: ${i.TIMESTAMP || 'N/A'}</div>
        </div>

        ${i.IMAGELINK ? `<div class="sec-title">E. Site Imagery</div><img src="${i.IMAGELINK}" style="width:100%; border-radius:10px; border:2px solid #cbd5e1; margin-top:10px; box-shadow:0 4px 6px rgba(0,0,0,0.1);">` : ''}
    `;
    document.getElementById('dataModal').style.display = 'block';
}

// --- DYNAMIC ANALYTICS ENGINE ---
function buildCharts(data) {
    const totalEl = document.getElementById('totalReportCount');
    if(totalEl) totalEl.innerText = `ANALYZING ${data.length} MATCHING RECORDS`;
    
    ['year','prov','trig','genSrc','specSrc','coords','loc','date','time','completenessTrig','completenessCat'].forEach(id => charts[id]?.destroy());

    const c = { year:{}, prov:{}, trig:{}, genSrc:{}, specSrc:{} };
    data.forEach(i => {
        if(i.year !== 'Unknown') c.year[i.year] = (c.year[i.year]||0)+1;
        if(i.PROVINCE) c.prov[i.PROVINCE] = (c.prov[i.PROVINCE]||0)+1;
        c.trig[i.LANDSLIDE||'Unspecified'] = (c.trig[i.LANDSLIDE||'Unspecified']||0)+1;
        c.genSrc[i.GENERALSOURCES||'N/A'] = (c.genSrc[i.GENERALSOURCES||'N/A']||0)+1;
        c.specSrc[i.SPECIFICSOURCE||'N/A'] = (c.specSrc[i.SPECIFICSOURCE||'N/A']||0)+1;
    });

    const allTime = { 
        coords:{'Has GPS':0,'No GPS':0}, 
        loc:{'Has Location':0,'No Location':0}, 
        date:{'Has Date':0,'Unknown Date':0}, 
        time:{'Has Time':0,'No Time':0},
        trigger:{'Has Data':0,'No Data':0},
        category:{'Has Data':0,'No Data':0}
    };
    
    db.forEach(i => {
        i.lat ? allTime.coords['Has GPS']++ : allTime.coords['No GPS']++;
        (i.PROVINCE||i.MUNICIPALITY) ? allTime.loc['Has Location']++ : allTime.loc['No Location']++;
        (i.YYYYMMDD && i.year !== 'Unknown') ? allTime.date['Has Date']++ : allTime.date['Unknown Date']++;
        (i['12HOURFO']) ? allTime.time['Has Time']++ : allTime.time['No Time']++;
        (i.LANDSLIDE && String(i.LANDSLIDE).trim() !== '' && i.LANDSLIDE !== 'Unspecified') ? allTime.trigger['Has Data']++ : allTime.trigger['No Data']++;
        (i.LANDSLID1 && String(i.LANDSLID1).trim() !== '' && i.LANDSLID1 !== 'Unspecified') ? allTime.category['Has Data']++ : allTime.category['No Data']++;
    });

    const createScrollableBar = (id, obj, color) => {
        let ent = Object.entries(obj).sort((a,b)=>b[1]-a[1]);
        const el = document.getElementById(id);
        const wrapper = document.getElementById('wrap-' + id);
        if(!el || !wrapper) return;
        
        wrapper.style.height = Math.max(300, ent.length * 35) + 'px';

        charts[id] = new Chart(el, { 
            type:'bar', 
            data: { labels: ent.map(x=>x[0]), datasets: [{data: ent.map(x=>x[1]), backgroundColor: color, borderRadius: 4}] }, 
            options: { 
                maintainAspectRatio: false, indexAxis:'y', 
                plugins: { legend: {display:false}, datalabels: {color:'#475569', anchor:'end', align:'right', font: {weight:'bold', size:12}, formatter: v => v>0?v:''} }, 
                layout: {padding: {right: 40}}, scales: { y: { ticks: { font: {weight:'bold'} } } }
            } 
        });
    };

    const createDonut = (id, obj, colors, hide) => {
        const el = document.getElementById(id);
        if(!el) return;
        charts[id] = new Chart(el, { 
            type:'doughnut', 
            data: { labels: Object.keys(obj), datasets: [{ data: Object.values(obj), backgroundColor: colors }] }, 
            options: { 
                maintainAspectRatio: false, 
                plugins: { 
                    legend: hide?{display:false}:{position:'bottom', labels: {font: {size:12, weight:'bold'}}}, 
                    datalabels: hide?{display:false}:{color:'#fff', font: {weight:'bold', size:12}, textAlign:'center', formatter:(v,c)=>{if(v===0)return''; let s=0; c.chart.data.datasets[0].data.map(d=>s+=d); return `${v}\n(${(v*100/s).toFixed(1)}%)`}} 
                } 
            } 
        });
    };

    const elYear = document.getElementById('chartYear');
    if(elYear) charts['year'] = new Chart(elYear, { type:'bar', data: { labels: Object.keys(c.year).sort(), datasets: [{data: Object.values(c.year), backgroundColor: '#3b82f6', borderRadius: 4}] }, options: { maintainAspectRatio: false, plugins: {legend:{display:false}, datalabels: {color:'#475569', anchor:'end', align:'top', font:{weight:'bold', size:13}, formatter:v=>v>0?v:''}}, layout:{padding:{top:25}}, scales: { x: { ticks: { font: {weight:'bold'} } } } } });
    
    createScrollableBar('chartProv', c.prov, '#f59e0b');
    createScrollableBar('chartGenSrc', c.genSrc, '#8b5cf6');
    createScrollableBar('chartSpecSrc', c.specSrc, '#ec4899');
    
    let trigsSorted = Object.entries(c.trig).sort((a,b)=>b[1]-a[1]);
    let sortedTrigObj = {}; trigsSorted.forEach(item => sortedTrigObj[item[0]] = item[1]);
    const trigPalette = ['#ef4444','#f59e0b','#3b82f6','#10b981','#6366f1','#8b5cf6','#ec4899','#14b8a6','#f43f5e', '#64748b', '#06b6d4'];
    createDonut('chartTrig', sortedTrigObj, trigPalette, true);

    const tBody = document.getElementById('tableTrig');
    if(tBody) {
        let tot = Object.values(c.trig).reduce((a, b) => a + b, 0);
        tBody.innerHTML = `<table style="width:100%; font-size:13px; font-weight:700; text-align:left; background:#1e293b; border-radius:8px; overflow:hidden; border: 2px solid #334155;"><thead><tr style="background:#0f172a; color:#fff;"><th style="padding:10px;">Trigger Event</th><th style="padding:10px; text-align:center;">Count</th><th style="padding:10px; text-align:center;">Share</th></tr></thead><tbody>` + 
        trigsSorted.map((item, i) => `<tr style="border-top:1px solid #334155; color:#fff;"><td style="padding:8px 10px; display:flex; align-items:center; gap:8px;"><span style="width:12px; height:12px; background:${trigPalette[i%trigPalette.length]}; border-radius:50%; display:inline-block; flex-shrink:0;"></span><span style="line-height:1.3;">${item[0]}</span></td><td style="padding:8px 10px; text-align:center; font-weight:900; color:#fef08a; font-size:14px;">${item[1]}</td><td style="padding:8px 10px; text-align:center; color:#fef08a;">${tot>0?((item[1]/tot)*100).toFixed(1)+'%':'0%'}</td></tr>`).join('') + `</tbody></table>`;
    }

    createDonut('chartCoords', allTime.coords, ['#10b981','#ef4444']);
    createDonut('chartLoc', allTime.loc, ['#10b981','#ef4444']);
    createDonut('chartDate', allTime.date, ['#10b981','#ef4444']);
    createDonut('chartTime', allTime.time, ['#10b981','#ef4444']);
    createDonut('chartCompletenessTrig', allTime.trigger, ['#10b981','#ef4444']);
    createDonut('chartCompletenessCat', allTime.category, ['#10b981','#ef4444']);
}

// --- UTILITIES ---
function downloadChart(id, name) {
    const canvas = document.getElementById(id), temp = document.createElement('canvas');
    if(!canvas) return;
    temp.width = canvas.width; temp.height = canvas.height;
    const ctx = temp.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,temp.width,temp.height); ctx.drawImage(canvas,0,0);
    const link = document.createElement('a'); link.download = name+'.png'; link.href = temp.toDataURL('image/png'); link.click();
}

function setStatus(msg, type) { document.getElementById('sys-text').innerText = msg; document.getElementById('sys-pulse').className = `pulse ${type}`; }
function openCharts() { document.getElementById('chartModal').style.display = 'block'; }
function closeCharts() { document.getElementById('chartModal').style.display = 'none'; }
function closeModal() { document.getElementById('dataModal').style.display = 'none'; }

function locateUser() {
    setStatus('SEARCHING GPS...', 'warning');
    map.locate({setView: true, maxZoom: 14});
    map.on('locationfound', (e) => {
        if(userMarker) map.removeLayer(userMarker);
        userMarker = L.circle(e.latlng, { radius: 100, color: '#3b82f6' }).addTo(map);
        setStatus('GPS LOCKED', 'online');
    });
    map.on('locationerror', () => { setStatus('GPS DENIED', 'error'); alert("Please enable location services."); });
}

function reset() {
    document.getElementById('q').value = '';
    document.getElementById('fY').value = '1'; 
    document.getElementById('fR').value = '';
    document.getElementById('fP').value = '';
    document.getElementById('fT').value = '';
    
    const extToggle = document.getElementById('fExtent');
    if(extToggle) extToggle.checked = false;
    
    map.setView(PH_CENTER, 5);
    updateDropdownOptions(); 
    filter(); 
}

window.onload = init;
