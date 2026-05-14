/* eslint-disable no-undef */
/*
 * MoCollisions - Montgomery County crash dashboard.
 *
 * Single-source-of-truth state (`state`) drives every chart, every chart
 * calls `setFilter()` to update state, and `render()` re-derives the filtered
 * slice and redraws every panel. All charts share one consistent severity
 * colour scale.
 */

// ----- Constants -----
const SEVERITY_ORDER = [
    "No Apparent Injury",
    "Possible Injury",
    "Suspected Minor Injury",
    "Suspected Serious Injury",
    "Fatal Injury",
    "Unknown",
];
const SEVERITY_COLORS = ["#5eead4", "#fcd34d", "#fb923c", "#f87171", "#dc2626", "#6b7280"];
const SEVERE_INDICES = new Set([3, 4]); // serious + fatal
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ----- Global state -----
const state = {
    summary: null,
    crashes: [],          // every record, numerically encoded
    zipGeo: null,
    catIndex: {},         // catCode -> { name -> idx }
    catList: {},          // catCode -> [names]
    filters: {
        years: new Set(),
        months: new Set(),
        dows: new Set(),
        hourStart: 0,
        hourEnd: 24,
        severity: new Set(),
        weather: new Set(),
        light: new Set(),
        surface: new Set(),
        collision: new Set(),
        distraction: new Set(),
        substance: new Set(),
        vehicle: new Set(),
        zip: null,
    },
    mapMode: "choropleth", // or "hex"
    mapMetric: "total",    // total | severe | rate
    severityBy: "speed",
    riskBy: "substance",
    zipForCrash: null,     // pre-computed zip code per crash (filled in later)
};

const tooltip = d3.select("#tooltip");

function _tipPos(evt) {
    const tipW = tooltip.node().offsetWidth || 200;
    const spaceRight = window.innerWidth - evt.clientX;
    const left = spaceRight > tipW + 20
        ? evt.clientX + 14
        : evt.clientX - tipW - 14;
    return { left: left + "px", top: (evt.clientY + 14) + "px" };
}
function showTip(html, evt) {
    tooltip.html(html).style("opacity", 1);
    const pos = _tipPos(evt);
    tooltip.style("left", pos.left).style("top", pos.top);
}
function moveTip(evt) {
    const pos = _tipPos(evt);
    tooltip.style("left", pos.left).style("top", pos.top);
}
function hideTip() { tooltip.style("opacity", 0); }


// ============================================================
// Data loading
// ============================================================

async function loadAll() {
    const [summary, zipGeo, rawText] = await Promise.all([
        d3.json("data/summary.json"),
        d3.json("data/mc_zipcodes.geojson"),
        d3.text("data/crashes_clean.csv"),
    ]);

    state.summary = summary;
    state.zipGeo = zipGeo;

    // Build category indices for fast string<->code lookup
    Object.entries(summary.categories).forEach(([k, names]) => {
        state.catList[k] = names;
        state.catIndex[k] = Object.fromEntries(names.map((n, i) => [n, i]));
    });

    parseCrashCSV(rawText);

    initFilters();
    render();
    d3.select("#loading-overlay").style("display", "none");
}

function parseCrashCSV(text) {
    // Manual parsing: faster + lighter than d3.csvParse + Object literals
    // for 213k rows. We turn each row into a plain object with numeric fields.
    const lines = text.split(/\r?\n/);
    const headers = lines[0].split(",");
    const idx = Object.fromEntries(headers.map((h, i) => [h, i]));

    const out = new Array(lines.length - 1);
    const zipForCrash = new Array(lines.length - 1);
    let w = 0;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const parts = line.split(",");
        out[w] = {
            year: +parts[idx.year],
            month: +parts[idx.month],   // 1..12
            dow: +parts[idx.dow],       // 0..6 (Mon..Sun, pandas dayofweek)
            hour: +parts[idx.hour],
            lat: +parts[idx.lat],
            lon: +parts[idx.lon],
            speed: +parts[idx.speed],
            severity: +parts[idx.severity],
            weather: +parts[idx.weather],
            light: +parts[idx.light],
            surface: +parts[idx.surface],
            collision: +parts[idx.collision],
            distraction: +parts[idx.distraction],
            substance: +parts[idx.substance],
            vehicle: +parts[idx.vehicle],
            at_fault: +parts[idx.at_fault],
            route: +parts[idx.route],
        };
        zipForCrash[w] = parts[idx.zip] || null;
        w++;
    }
    out.length = w;
    zipForCrash.length = w;
    state.crashes = out;
    state.zipForCrash = zipForCrash;
}


// ============================================================
// Filters
// ============================================================

function initFilters() {
    // Years
    const ymin = state.summary.year_min;
    const ymax = state.summary.year_max;
    const years = d3.range(ymin, ymax + 1);
    buildChipRow("#filter-year", years.map(y => ({ value: y, label: y })), "years");

    // Days of week
    buildChipRow("#filter-dow", DOW_LABELS.map((d, i) => ({ value: i, label: d })), "dows");

    // Months
    buildChipRow("#filter-month", MONTH_LABELS.map((m, i) => ({ value: i + 1, label: m })), "months");

    // Severity (special - keep order)
    buildChipCol("#filter-severity",
        SEVERITY_ORDER.map((s, i) => ({ value: i, label: s, color: SEVERITY_COLORS[i] })),
        "severity");

    // Weather, light, surface
    [
        ["#filter-weather", "weather"],
        ["#filter-light", "light"],
        ["#filter-surface", "surface"],
    ].forEach(([sel, key]) => {
        const items = state.catList[key].map((name, i) => ({ value: i, label: name }));
        buildChipCol(sel, items, key);
    });

    // Time
    d3.select("#filter-time-start").on("change", onTimeChange);
    d3.select("#filter-time-end").on("change", onTimeChange);

    // Reset
    d3.select("#reset-filters").on("click", () => {
        Object.keys(state.filters).forEach(k => {
            if (state.filters[k] instanceof Set) state.filters[k].clear();
        });
        state.filters.hourStart = 0;
        state.filters.hourEnd = 24;
        state.filters.zip = null;
        d3.select("#filter-time-start").property("value", "00:00");
        d3.select("#filter-time-end").property("value", "23:59");
        d3.selectAll(".chip.active").classed("active", false);
        render();
    });

    // Map toggles
    d3.selectAll('[data-map]').on("click", function () {
        const m = this.dataset.map;
        state.mapMode = m;
        d3.selectAll('[data-map]').classed("active", false);
        d3.select(this).classed("active", true);
        drawMap();
    });
    d3.selectAll('[data-metric]').on("click", function () {
        state.mapMetric = this.dataset.metric;
        d3.selectAll('[data-metric]').classed("active", false);
        d3.select(this).classed("active", true);
        drawMap();
    });

    d3.select("#severity-by").on("change", function () {
        state.severityBy = this.value;
        drawStackedBar();
    });
    d3.select("#risk-by").on("change", function () {
        state.riskBy = this.value;
        drawRisk();
    });
}

function buildChipRow(selector, items, key) {
    const container = d3.select(selector).classed("chip-row", true);
    container.selectAll(".chip")
        .data(items)
        .join("div")
        .attr("class", "chip")
        .text(d => d.label)
        .on("click", function (event, d) {
            toggleSetFilter(key, d.value);
            d3.select(this).classed("active", state.filters[key].has(d.value));
            render();
        });
}

function buildChipCol(selector, items, key) {
    const container = d3.select(selector).classed("chip-col", true);
    container.selectAll(".chip")
        .data(items)
        .join("div")
        .attr("class", "chip")
        .html(d => d.color
            ? `<span class="sev-dot" style="background:${d.color}"></span>${d.label}`
            : d.label)
        .on("click", function (event, d) {
            toggleSetFilter(key, d.value);
            d3.select(this).classed("active", state.filters[key].has(d.value));
            render();
        });
}

function toggleSetFilter(key, value) {
    const s = state.filters[key];
    if (s.has(value)) s.delete(value);
    else s.add(value);
}

function onTimeChange() {
    const [h1, m1] = d3.select("#filter-time-start").property("value").split(":").map(Number);
    const [h2, m2] = d3.select("#filter-time-end").property("value").split(":").map(Number);
    state.filters.hourStart = h1 + m1 / 60;
    state.filters.hourEnd = h2 + m2 / 60 + 0.0001; // include the end hour
    render();
}


// ============================================================
// Filtering & derived data
// ============================================================

function filterCrashes() {
    const f = state.filters;
    const hasYears = f.years.size > 0;
    const hasMonths = f.months.size > 0;
    const hasDows = f.dows.size > 0;
    const hasSev = f.severity.size > 0;
    const hasW = f.weather.size > 0;
    const hasL = f.light.size > 0;
    const hasS = f.surface.size > 0;
    const hasC = f.collision.size > 0;
    const hasD = f.distraction.size > 0;
    const hasSu = f.substance.size > 0;
    const hasV = f.vehicle.size > 0;
    const hStart = f.hourStart;
    const hEnd = f.hourEnd;
    const zipFilter = f.zip;

    const arr = state.crashes;
    const zipForCrash = state.zipForCrash;
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (hasYears && !f.years.has(c.year)) continue;
        if (hasMonths && !f.months.has(c.month)) continue;
        if (hasDows && !f.dows.has(c.dow)) continue;
        const hr = c.hour;
        if (hr < hStart || hr >= hEnd) continue;
        if (hasSev && !f.severity.has(c.severity)) continue;
        if (hasW && !f.weather.has(c.weather)) continue;
        if (hasL && !f.light.has(c.light)) continue;
        if (hasS && !f.surface.has(c.surface)) continue;
        if (hasC && !f.collision.has(c.collision)) continue;
        if (hasD && !f.distraction.has(c.distraction)) continue;
        if (hasSu && !f.substance.has(c.substance)) continue;
        if (hasV && !f.vehicle.has(c.vehicle)) continue;
        if (zipFilter && zipForCrash[i] !== zipFilter) continue;
        out.push(c);
    }
    return out;
}


// ============================================================
// Render orchestration
// ============================================================

let filteredCache = [];

function render() {
    filteredCache = filterCrashes();
    drawKPIs(filteredCache);
    drawActiveChips();
    drawMap();
    drawTimeSeries(filteredCache);
    drawHeatmap(filteredCache);
    drawStackedBar();
    drawCollisionBar(filteredCache);
    drawRisk();
    drawHourlyChart(filteredCache);
    drawVehicleBar(filteredCache);
    drawInsights(filteredCache);
}


// ============================================================
// KPI cards
// ============================================================

function drawKPIs(data) {
    const total = data.length;
    const sevCounts = new Array(SEVERITY_ORDER.length).fill(0);
    let atFaultYes = 0, atFaultKnown = 0, substanceBad = 0, substanceKnown = 0;
    let distractedBad = 0, distractedKnown = 0;
    const SUB_BAD = new Set(["Alcohol", "Drug", "Combined", "Alcohol + Drug suspected"]
        .map(s => state.catIndex.substance[s]).filter(v => v !== undefined));
    const FAULT_YES = state.catIndex.at_fault["Yes"];
    const FAULT_UNK = state.catIndex.at_fault["Unknown"];
    const DIST_UNK = state.catIndex.distraction["Unknown"];
    const DIST_NOT = state.catIndex.distraction["Not Distracted"];

    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        sevCounts[c.severity]++;
        if (c.at_fault !== FAULT_UNK) {
            atFaultKnown++;
            if (c.at_fault === FAULT_YES) atFaultYes++;
        }
        if (SUB_BAD.has(c.substance)) substanceBad++;
        if (c.substance !== state.catIndex.substance["Unknown"]) substanceKnown++;
        if (c.distraction !== DIST_UNK) {
            distractedKnown++;
            if (c.distraction !== DIST_NOT) distractedBad++;
        }
    }
    const fatal = sevCounts[state.catIndex.severity["Fatal Injury"]];
    const serious = sevCounts[state.catIndex.severity["Suspected Serious Injury"]];

    const fmt = d3.format(",");
    d3.select("#kpi-total").text(fmt(total));
    d3.select("#kpi-total-sub").style("display", total < state.crashes.length ? null : "none");
    d3.select("#kpi-total-all").text(fmt(state.crashes.length));
    d3.select("#kpi-fatal").text(fmt(fatal));
    d3.select("#kpi-fatal-rate").text(total ? (fatal / total * 1000).toFixed(2) + " per 1,000 crashes" : "\u2014");
    d3.select("#kpi-serious").text(fmt(serious));
    d3.select("#kpi-serious-rate").text(total ? (serious / total * 1000).toFixed(1) + " per 1,000 crashes" : "\u2014");

    const faultPct = atFaultKnown ? (atFaultYes / atFaultKnown * 100).toFixed(1) + "%" : "\u2014";
    d3.select("#kpi-fault").text(faultPct);
    const subPct = total ? (substanceBad / total * 100).toFixed(2) + "%" : "\u2014";
    d3.select("#kpi-substance").text(subPct);
    const distPct = distractedKnown ? (distractedBad / distractedKnown * 100).toFixed(1) + "%" : "\u2014";
    d3.select("#kpi-distracted").text(distPct);
}


// ============================================================
// Active filter chips
// ============================================================

function drawActiveChips() {
    const cont = d3.select("#active-filters");
    cont.selectAll("*").remove();

    const f = state.filters;
    const chips = [];

    const sets = [
        ["years", "Year", Array.from(f.years).sort((a, b) => a - b), v => v],
        ["months", "Month", Array.from(f.months).sort((a, b) => a - b), v => MONTH_LABELS[v - 1]],
        ["dows", "Day", Array.from(f.dows).sort((a, b) => a - b), v => DOW_LABELS[v]],
        ["severity", "Severity", Array.from(f.severity), v => state.catList.severity[v]],
        ["weather", "Weather", Array.from(f.weather), v => state.catList.weather[v]],
        ["light", "Light", Array.from(f.light), v => state.catList.light[v]],
        ["surface", "Surface", Array.from(f.surface), v => state.catList.surface[v]],
        ["collision", "Collision", Array.from(f.collision), v => state.catList.collision[v]],
        ["distraction", "Distraction", Array.from(f.distraction), v => state.catList.distraction[v]],
        ["substance", "Substance", Array.from(f.substance), v => state.catList.substance[v]],
        ["vehicle", "Vehicle", Array.from(f.vehicle), v => state.catList.vehicle[v]],
    ];

    sets.forEach(([key, label, vals, fn]) => {
        vals.forEach(v => chips.push({ key, label, value: v, text: fn(v) }));
    });

    if (f.hourStart > 0 || f.hourEnd < 24) {
        const fmt = h => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
        chips.push({ key: "hour", label: "Time", value: null, text: `${fmt(f.hourStart)}\u2013${fmt(Math.min(24, f.hourEnd))}` });
    }
    if (f.zip) chips.push({ key: "zip", label: "ZIP", value: f.zip, text: f.zip });

    cont.selectAll("span.active-chip")
        .data(chips)
        .join("span")
        .attr("class", "active-chip")
        .html(d => `<span class="tt-k">${d.label}:</span> ${d.text} <span class="close">\u2715</span>`)
        .on("click", function (e, d) {
            if (d.key === "hour") {
                f.hourStart = 0; f.hourEnd = 24;
                d3.select("#filter-time-start").property("value", "00:00");
                d3.select("#filter-time-end").property("value", "23:59");
            } else if (d.key === "zip") {
                f.zip = null;
            } else {
                f[d.key].delete(d.value);
            }
            syncRailChips();
            render();
        });

    if (chips.length > 0) {
        cont.append("span")
            .attr("class", "clear-all-chip")
            .text("Clear all")
            .on("click", () => d3.select("#reset-filters").dispatch("click"));
    }
}

function syncRailChips() {
    const map = {
        years: "filter-year", months: "filter-month", dows: "filter-dow",
        severity: "filter-severity", weather: "filter-weather",
        light: "filter-light", surface: "filter-surface",
    };
    Object.entries(map).forEach(([key, id]) => {
        d3.select("#" + id).selectAll(".chip").each(function (d) {
            d3.select(this).classed("active", state.filters[key].has(d.value));
        });
    });
}


// ============================================================
// Map (choropleth + hexbin)
// ============================================================

let mapProjection = null;
let mapPath = null;

function drawMap() {
    const container = d3.select("#map");
    container.selectAll("*").remove();
    const rect = container.node().getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    const svg = container.append("svg")
        .attr("width", w)
        .attr("height", h)
        .attr("viewBox", `0 0 ${w} ${h}`);

    // Fit projection to the zip GeoJSON bounds
    mapProjection = d3.geoMercator().fitSize([w - 20, h - 20], state.zipGeo);
    mapPath = d3.geoPath(mapProjection);

    // Compute per-ZIP aggregates from the filtered set
    const data = filteredCache;
    const zipAgg = new Map(); // zip -> {total, severe}
    for (const f of state.zipGeo.features) {
        zipAgg.set(f.properties.zip, { total: 0, severe: 0, fatal: 0 });
    }
    const zipForCrash = state.zipForCrash;
    for (let i = 0; i < state.crashes.length; i++) {
        // We need to use filteredCache, but it doesn't carry the original
        // index. Compute via secondary loop instead.
    }
    // Recompute using filteredCache vs original crash list lookup:
    // For perf, walk the original array, applying the same filter via index.
    // Simpler: walk the filteredCache and look up each crash's ZIP via a map.
    // We don't have a fast lookup from crash object -> index. Re-derive by
    // walking the original array and checking filter conditions inline.
    aggregateZipsFromOriginal(zipAgg);

    // Color scale
    let metricFn, colorScale, legendLabel;
    if (state.mapMetric === "severe") {
        metricFn = a => a.severe;
        legendLabel = "Serious + fatal crashes";
    } else if (state.mapMetric === "rate") {
        metricFn = a => a.total > 30 ? a.severe / a.total : null;
        legendLabel = "Severity rate (severe + fatal / total)";
    } else {
        metricFn = a => a.total;
        legendLabel = "Total crashes";
    }

    const vals = [];
    zipAgg.forEach(v => { const m = metricFn(v); if (m != null) vals.push(m); });
    const valExtent = d3.extent(vals);

    if (state.mapMetric === "rate") {
        colorScale = d3.scaleSequential(d3.interpolateInferno).domain(valExtent);
    } else {
        colorScale = d3.scaleSequentialSqrt(d3.interpolateYlOrRd).domain([0, valExtent[1] || 1]);
    }

    // Draw choropleth always (acts as base layer in hex mode too)
    const showFill = state.mapMode === "choropleth";

    svg.append("g")
        .attr("class", "zips")
        .selectAll("path")
        .data(state.zipGeo.features)
        .join("path")
        .attr("d", mapPath)
        .attr("class", d => "zip-region" + (state.filters.zip === d.properties.zip ? " selected" : ""))
        .attr("fill", d => {
            if (!showFill) return "rgba(99,102,241,0.06)";
            const v = metricFn(zipAgg.get(d.properties.zip));
            if (v == null || v === 0) return "rgba(255,255,255,0.05)";
            return colorScale(v);
        })
        .on("mousemove", function (event, d) {
            const a = zipAgg.get(d.properties.zip);
            const ratePct = a.total ? (a.severe / a.total * 100).toFixed(2) + "%" : "\u2014";
            showTip(`<strong>ZIP ${d.properties.zip}</strong>
                <div class="tt-row"><span class="tt-k">Crashes</span><span>${d3.format(",")(a.total)}</span></div>
                <div class="tt-row"><span class="tt-k">Serious + fatal</span><span>${d3.format(",")(a.severe)}</span></div>
                <div class="tt-row"><span class="tt-k">Fatal</span><span>${d3.format(",")(a.fatal)}</span></div>
                <div class="tt-row"><span class="tt-k">Severity rate</span><span>${ratePct}</span></div>`, event);
        })
        .on("mouseout", hideTip)
        .on("click", function (event, d) {
            state.filters.zip = state.filters.zip === d.properties.zip ? null : d.properties.zip;
            render();
        });

    // Hex overlay
    if (state.mapMode === "hex") {
        // Project filtered crashes
        const points = [];
        for (let i = 0; i < data.length; i++) {
            const p = mapProjection([data[i].lon, data[i].lat]);
            if (p) points.push(p);
        }
        const hex = d3.hexbin()
            .x(d => d[0]).y(d => d[1])
            .radius(7)
            .extent([[0, 0], [w, h]]);
        const bins = hex(points);
        const maxBin = d3.max(bins, b => b.length) || 1;
        const hexColor = d3.scaleSequentialSqrt(colorScale.interpolator()).domain([0, maxBin]);

        svg.append("g")
            .attr("class", "hexes")
            .selectAll("path")
            .data(bins)
            .join("path")
            .attr("class", "hex")
            .attr("d", hex.hexagon())
            .attr("transform", d => `translate(${d.x},${d.y})`)
            .attr("fill", d => hexColor(d.length))
            .attr("fill-opacity", 0.85)
            .on("mousemove", function (event, d) {
                showTip(`<strong>${d3.format(",")(d.length)}</strong> crashes in this cluster`, event);
            })
            .on("mouseout", hideTip);
    }

    drawMapLegend(legendLabel, colorScale, valExtent);

    d3.select("#map-sub").text(state.mapMode === "hex"
        ? `Hex-bin density of ${d3.format(",")(data.length)} filtered crashes (ZIPs in background)`
        : `ZIP-code choropleth - ${legendLabel.toLowerCase()} - click a ZIP to filter`);
}

function aggregateZipsFromOriginal(zipAgg) {
    // Walk original array, apply same filter conditions inline, increment ZIP counts.
    const f = state.filters;
    const hasYears = f.years.size > 0;
    const hasMonths = f.months.size > 0;
    const hasDows = f.dows.size > 0;
    const hasSev = f.severity.size > 0;
    const hasW = f.weather.size > 0;
    const hasL = f.light.size > 0;
    const hasS = f.surface.size > 0;
    const hasC = f.collision.size > 0;
    const hasD = f.distraction.size > 0;
    const hasSu = f.substance.size > 0;
    const hasV = f.vehicle.size > 0;
    const hStart = f.hourStart;
    const hEnd = f.hourEnd;
    const arr = state.crashes;
    const zipForCrash = state.zipForCrash;
    const sevSerious = state.catIndex.severity["Suspected Serious Injury"];
    const sevFatal = state.catIndex.severity["Fatal Injury"];

    for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        const z = zipForCrash[i];
        if (!z) continue;
        if (hasYears && !f.years.has(c.year)) continue;
        if (hasMonths && !f.months.has(c.month)) continue;
        if (hasDows && !f.dows.has(c.dow)) continue;
        if (c.hour < hStart || c.hour >= hEnd) continue;
        if (hasSev && !f.severity.has(c.severity)) continue;
        if (hasW && !f.weather.has(c.weather)) continue;
        if (hasL && !f.light.has(c.light)) continue;
        if (hasS && !f.surface.has(c.surface)) continue;
        if (hasC && !f.collision.has(c.collision)) continue;
        if (hasD && !f.distraction.has(c.distraction)) continue;
        if (hasSu && !f.substance.has(c.substance)) continue;
        if (hasV && !f.vehicle.has(c.vehicle)) continue;
        // NOTE: we intentionally ignore the ZIP filter when computing the
        // choropleth so the user can see every ZIP, with the selected one
        // highlighted.
        const a = zipAgg.get(z);
        a.total++;
        if (c.severity === sevSerious || c.severity === sevFatal) a.severe++;
        if (c.severity === sevFatal) a.fatal++;
    }
}

function drawMapLegend(label, scale, extent) {
    const wrap = d3.select("#map-legend");
    wrap.selectAll("*").remove();
    const w = 220, h = 10;
    wrap.append("span").text(label);
    const svg = wrap.append("svg").attr("width", w + 60).attr("height", h + 24);
    const grad = svg.append("defs").append("linearGradient").attr("id", "lg-grad");
    const n = 8;
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        grad.append("stop").attr("offset", (t * 100) + "%").attr("stop-color", scale(extent[0] + t * (extent[1] - extent[0])));
    }
    svg.append("rect").attr("x", 30).attr("y", 4).attr("width", w).attr("height", h).attr("fill", "url(#lg-grad)").attr("stroke", "rgba(255,255,255,0.2)");
    const fmt = state.mapMetric === "rate" ? d3.format(".1%") : d3.format(",.0f");
    svg.append("text").attr("x", 28).attr("y", 26).attr("text-anchor", "end").attr("font-size", 10).attr("fill", "var(--text-muted)").text(fmt(extent[0] || 0));
    svg.append("text").attr("x", w + 32).attr("y", 26).attr("font-size", 10).attr("fill", "var(--text-muted)").text(fmt(extent[1] || 0));
}


// ============================================================
// Time series
// ============================================================

function drawTimeSeries(data) {
    const container = d3.select("#timeseries");
    container.selectAll("*").remove();
    const rect = container.node().getBoundingClientRect();
    const margin = { top: 20, right: 20, bottom: 30, left: 50 };
    const w = rect.width - margin.left - margin.right;
    const h = 260 - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", w + margin.left + margin.right)
        .attr("height", h + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Bin by month
    const byMonth = d3.rollup(data,
        v => v.length,
        d => d.year * 12 + (d.month - 1)
    );
    const ymin = state.summary.year_min;
    const ymax = state.summary.year_max;
    const monthsRange = d3.range(ymin * 12, ymax * 12 + 12);
    const series = monthsRange.map(m => ({
        ym: m,
        date: new Date(Math.floor(m / 12), m % 12, 1),
        count: byMonth.get(m) || 0,
    }));

    const x = d3.scaleTime().domain(d3.extent(series, d => d.date)).range([0, w]);
    const y = d3.scaleLinear().domain([0, d3.max(series, d => d.count) || 1]).nice().range([h, 0]);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(8));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d3.format(",")));
    svg.append("g").attr("class", "grid")
        .call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));

    const area = d3.area()
        .curve(d3.curveMonotoneX)
        .x(d => x(d.date))
        .y0(h)
        .y1(d => y(d.count));
    const line = d3.line()
        .curve(d3.curveMonotoneX)
        .x(d => x(d.date))
        .y(d => y(d.count));

    const grad = svg.append("defs").append("linearGradient")
        .attr("id", "ts-grad").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 1);
    grad.append("stop").attr("offset", "0%").attr("stop-color", "#6366f1").attr("stop-opacity", 0.55);
    grad.append("stop").attr("offset", "100%").attr("stop-color", "#6366f1").attr("stop-opacity", 0);

    svg.append("path").datum(series).attr("fill", "url(#ts-grad)").attr("d", area);
    svg.append("path").datum(series).attr("fill", "none").attr("stroke", "#a5b4fc").attr("stroke-width", 1.6).attr("d", line);

    // Hover line
    const focus = svg.append("g").style("display", "none").style("pointer-events", "none");
    focus.append("line").attr("stroke", "white").attr("stroke-opacity", 0.4).attr("y1", 0).attr("y2", h);
    focus.append("circle").attr("r", 4).attr("fill", "#a5b4fc");

    // Brush for filtering year range
    let suppressBrushEnd = false;
    const brush = d3.brushX()
        .extent([[0, 0], [w, h]])
        .on("end", function (event) {
            if (suppressBrushEnd) return;
            if (!event.sourceEvent) return; // ignore programmatic clears
            if (!event.selection) {
                state.filters.years.clear();
                d3.selectAll("#filter-year .chip").classed("active", false);
                render();
                return;
            }
            const [x0, x1] = event.selection.map(x.invert);
            const yStart = x0.getFullYear();
            const yEnd = x1.getFullYear();
            state.filters.years.clear();
            for (let yr = yStart; yr <= yEnd; yr++) state.filters.years.add(yr);
            d3.selectAll("#filter-year .chip").each(function (d) {
                d3.select(this).classed("active", state.filters.years.has(d.value));
            });
            render();
        });
    const brushG = svg.append("g").attr("class", "brush").call(brush);

    // Hover handler runs on the brush overlay (catches all events in the area)
    brushG.select(".overlay")
        .style("cursor", "crosshair")
        .on("mouseover.tip", () => focus.style("display", null))
        .on("mouseout.tip", () => { focus.style("display", "none"); hideTip(); })
        .on("mousemove.tip", function (event) {
            const [mx] = d3.pointer(event);
            const t = x.invert(mx);
            const i = d3.bisector(d => d.date).left(series, t);
            const d = series[Math.min(i, series.length - 1)];
            focus.attr("transform", `translate(${x(d.date)},${y(d.count)})`);
            showTip(`<strong>${d3.timeFormat("%b %Y")(d.date)}</strong>
                <div class="tt-row"><span class="tt-k">Crashes</span><span>${d3.format(",")(d.count)}</span></div>`, event);
        });
}


// ============================================================
// Heatmap (hour x day-of-week)
// ============================================================

function drawHeatmap(data) {
    const container = d3.select("#heatmap");
    container.selectAll("*").remove();
    const rect = container.node().getBoundingClientRect();
    const margin = { top: 12, right: 12, bottom: 40, left: 38 };
    const w = rect.width - margin.left - margin.right;
    const h = 260 - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", w + margin.left + margin.right)
        .attr("height", h + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const grid = d3.range(7).map(() => new Array(24).fill(0));
    for (const c of data) grid[c.dow][c.hour]++;

    const maxVal = d3.max(grid.flat()) || 1;
    const color = d3.scaleSequential(d3.interpolateInferno).domain([0, maxVal]);

    const cellW = w / 24;
    const cellH = h / 7;

    const cells = [];
    for (let d = 0; d < 7; d++)
        for (let hr = 0; hr < 24; hr++)
            cells.push({ d, hr, v: grid[d][hr] });

    svg.selectAll("rect")
        .data(cells)
        .join("rect")
        .attr("class", d => "heatmap-cell" + (state.filters.dows.size && !state.filters.dows.has(d.d) ? " dimmed" : ""))
        .attr("x", d => d.hr * cellW + 1)
        .attr("y", d => d.d * cellH + 1)
        .attr("width", cellW - 2)
        .attr("height", cellH - 2)
        .attr("fill", d => color(d.v))
        .attr("rx", 2)
        .on("mousemove", function (event, d) {
            showTip(`<strong>${DOW_LABELS[d.d]} ${String(d.hr).padStart(2, "0")}:00</strong>
                <div class="tt-row"><span class="tt-k">Crashes</span><span>${d3.format(",")(d.v)}</span></div>`, event);
        })
        .on("mouseout", hideTip)
        .on("click", function (event, d) {
            // Click toggles that day (most useful single filter)
            if (state.filters.dows.has(d.d)) state.filters.dows.delete(d.d);
            else state.filters.dows.add(d.d);
            d3.selectAll("#filter-dow .chip").each(function (cd) {
                d3.select(this).classed("active", state.filters.dows.has(cd.value));
            });
            render();
        });

    // Hour axis (every 3 hours)
    svg.append("g").attr("class", "axis")
        .attr("transform", `translate(0,${h})`)
        .call(d3.axisBottom(d3.scaleLinear().domain([0, 24]).range([0, w])).ticks(8).tickFormat(d => d + ":00"));

    // DOW axis
    svg.append("g").selectAll("text")
        .data(DOW_LABELS).join("text")
        .attr("class", "tick-d")
        .attr("text-anchor", "end")
        .attr("x", -6)
        .attr("y", (d, i) => i * cellH + cellH / 2 + 3)
        .text(d => d);
}


// ============================================================
// Stacked bar (severity by category)
// ============================================================

function drawStackedBar() {
    const container = d3.select("#stacked-bar");
    container.selectAll("*").remove();

    const data = filteredCache;
    const groupKey = state.severityBy;

    // Group by selected dimension. For "speed" we use a custom bucketing.
    const groupOf = c => {
        if (groupKey === "speed") {
            if (c.speed < 0) return "Unknown";
            if (c.speed === 0) return "0 (parking lot)";
            if (c.speed <= 20) return "1-20 mph";
            if (c.speed <= 30) return "25-30 mph";
            if (c.speed <= 40) return "35-40 mph";
            if (c.speed <= 50) return "45-50 mph";
            return "55+ mph";
        }
        return state.catList[groupKey][c[groupKey]];
    };

    const counts = d3.rollup(data,
        v => {
            const sev = new Array(SEVERITY_ORDER.length).fill(0);
            for (const r of v) sev[r.severity]++;
            return sev;
        },
        groupOf
    );

    const groups = Array.from(counts.entries())
        .map(([k, sev]) => ({ key: k, total: d3.sum(sev), sev }))
        .filter(d => d.key && d.key !== "Unknown" && d.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 12);

    const rect = container.node().getBoundingClientRect();
    const margin = { top: 12, right: 12, bottom: 72, left: 110 };
    const w = rect.width - margin.left - margin.right;
    const h = Math.max(260, groups.length * 28) - margin.top - margin.bottom;

    const rootSvg = container.append("svg")
        .attr("width", w + margin.left + margin.right)
        .attr("height", h + margin.top + margin.bottom);

    const clipId = "stacked-bar-clip";
    rootSvg.append("defs").append("clipPath").attr("id", clipId)
        .append("rect").attr("width", w).attr("height", h);

    const svg = rootSvg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const y = d3.scaleBand().domain(groups.map(d => d.key)).range([0, h]).padding(0.18);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`)
        .call(d3.axisBottom(d3.scaleLinear().domain([0, 1]).range([0, w])).ticks(5).tickFormat(d3.format(".0%")))
        .call(g => g.select(".tick:first-child text").attr("text-anchor", "start"))
        .call(g => g.select(".tick:last-child text").attr("text-anchor", "end"));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y));

    const grp = svg.append("g").attr("clip-path", `url(#${clipId})`)
        .selectAll("g.row").data(groups).join("g").attr("class", "row")
        .attr("transform", d => `translate(0,${y(d.key)})`);

    // Use integer cumulative sums → pixel positions to guarantee bars end exactly at w
    grp.each(function (d) {
        const sel = d3.select(this);
        let cumLeft = 0;
        d.sev.forEach((c, i) => {
            const cumRight = cumLeft + c;
            if (c > 0) {
                const px0 = cumLeft / d.total * w;
                const px1 = cumRight / d.total * w;
                sel.append("rect")
                    .attr("x", px0)
                    .attr("y", 0)
                    .attr("height", y.bandwidth())
                    .attr("width", Math.max(0, px1 - px0))
                    .style("fill", SEVERITY_COLORS[i])
                    .attr("opacity", 0.95)
                    .on("mousemove", function (event) {
                        const pct = c / d.total;
                        showTip(`<strong>${d.key}</strong> &middot; ${SEVERITY_ORDER[i]}
                            <div class="tt-row"><span class="tt-k">Crashes</span><span>${d3.format(",")(c)}</span></div>
                            <div class="tt-row"><span class="tt-k">Share</span><span>${(pct * 100).toFixed(1)}%</span></div>`, event);
                    })
                    .on("mouseout", hideTip)
                    .on("click", function () {
                        if (groupKey !== "speed") {
                            state.filters[groupKey].add(state.catIndex[groupKey][d.key]);
                            d3.selectAll(`#filter-${groupKey} .chip`).each(function (cd) {
                                d3.select(this).classed("active", state.filters[groupKey].has(cd.value));
                            });
                            render();
                        }
                    });
            }
            cumLeft = cumRight;
        });
    });

    // Legend — 3 rows of 2, wide enough for long severity labels
    const legendItemW = Math.floor(w / 2);
    const legend = svg.append("g").attr("transform", `translate(0,${h + 28})`);
    SEVERITY_ORDER.forEach((s, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const g = legend.append("g").attr("transform", `translate(${col * legendItemW},${row * 16})`);
        g.append("rect").attr("width", 10).attr("height", 10).attr("y", -8).attr("fill", SEVERITY_COLORS[i]).attr("rx", 2);
        g.append("text").attr("x", 14).attr("y", 1).attr("font-size", 10).attr("fill", "var(--text-soft)").text(s);
    });
}


// ============================================================
// Top collision types
// ============================================================

function drawCollisionBar(data) {
    const container = d3.select("#collision-bar");
    container.selectAll("*").remove();

    const counts = new Array(state.catList.collision.length).fill(0);
    for (const c of data) counts[c.collision]++;

    const items = state.catList.collision.map((name, i) => ({ name, value: counts[i], idx: i }))
        .filter(d => d.name !== "Unknown" && d.value > 0)
        .sort((a, b) => b.value - a.value);

    const rect = container.node().getBoundingClientRect();
    const margin = { top: 12, right: 40, bottom: 20, left: 100 };
    const w = rect.width - margin.left - margin.right;
    const h = Math.max(220, items.length * 26) - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", w + margin.left + margin.right)
        .attr("height", h + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain([0, d3.max(items, d => d.value) || 1]).nice().range([0, w]);
    const y = d3.scaleBand().domain(items.map(d => d.name)).range([0, h]).padding(0.18);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`)
        .call(d3.axisBottom(x).ticks(4).tickFormat(d3.format("~s")));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y));

    svg.selectAll("rect.bar")
        .data(items)
        .join("rect")
        .attr("class", "bar")
        .attr("x", 0)
        .attr("y", d => y(d.name))
        .attr("height", y.bandwidth())
        .attr("width", d => x(d.value))
        .attr("fill", d => state.filters.collision.has(d.idx) ? "#22d3ee" : "#6366f1")
        .attr("rx", 3)
        .style("cursor", "pointer")
        .on("mousemove", function (event, d) {
            const pct = data.length ? (d.value / data.length * 100).toFixed(1) : 0;
            showTip(`<strong>${d.name}</strong>
                <div class="tt-row"><span class="tt-k">Crashes</span><span>${d3.format(",")(d.value)}</span></div>
                <div class="tt-row"><span class="tt-k">Share</span><span>${pct}%</span></div>`, event);
        })
        .on("mouseout", hideTip)
        .on("click", function (event, d) {
            if (state.filters.collision.has(d.idx)) state.filters.collision.delete(d.idx);
            else state.filters.collision.add(d.idx);
            render();
        });

    svg.selectAll("text.val")
        .data(items)
        .join("text")
        .attr("class", "bar-label")
        .attr("x", d => x(d.value) + 5)
        .attr("y", d => y(d.name) + y.bandwidth() / 2 + 4)
        .text(d => d3.format(",")(d.value));
}


// ============================================================
// Risk-factor lift chart
// ============================================================

function drawRisk() {
    const container = d3.select("#risk-chart");
    container.selectAll("*").remove();

    const data = filteredCache;
    if (data.length === 0) {
        container.append("p").style("padding", "1rem").style("color", "var(--text-muted)")
            .text("No crashes in the current filter.");
        return;
    }

    const dim = state.riskBy;
    const severeIdx = state.catIndex.severity["Suspected Serious Injury"];
    const fatalIdx = state.catIndex.severity["Fatal Injury"];

    const groupOf = c => {
        if (dim === "speed") {
            if (c.speed < 0) return null;
            if (c.speed === 0) return "0 mph";
            if (c.speed <= 20) return "1-20";
            if (c.speed <= 30) return "25-30";
            if (c.speed <= 40) return "35-40";
            if (c.speed <= 50) return "45-50";
            return "55+";
        }
        const name = state.catList[dim][c[dim]];
        if (name === "Unknown" || name === "Other / Unknown" || name === "Other") return null;
        return name;
    };

    const totals = new Map(); // group -> { total, severe }
    let allTotal = 0, allSevere = 0;
    for (const c of data) {
        const g = groupOf(c);
        if (g == null) continue;
        if (!totals.has(g)) totals.set(g, { total: 0, severe: 0 });
        const t = totals.get(g);
        t.total++;
        allTotal++;
        if (c.severity === severeIdx || c.severity === fatalIdx) {
            t.severe++;
            allSevere++;
        }
    }
    const baseline = allTotal ? allSevere / allTotal : 0;

    // Only include groups with at least 50 crashes
    const items = Array.from(totals.entries())
        .map(([k, v]) => ({
            key: k,
            total: v.total,
            severe: v.severe,
            rate: v.total ? v.severe / v.total : 0,
            lift: baseline > 0 ? (v.severe / v.total) / baseline : 0,
        }))
        .filter(d => d.total >= 50)
        .sort((a, b) => b.lift - a.lift)
        .slice(0, 12);

    if (items.length === 0) {
        container.append("p").style("padding", "1rem").style("color", "var(--text-muted)")
            .text("Not enough data in this slice to compute lift.");
        return;
    }

    const rect = container.node().getBoundingClientRect();
    const margin = { top: 14, right: 40, bottom: 32, left: 130 };
    const w = rect.width - margin.left - margin.right;
    const h = Math.max(220, items.length * 26) - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", w + margin.left + margin.right)
        .attr("height", h + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const maxLift = d3.max(items, d => d.lift) || 1;
    const x = d3.scaleLinear().domain([0, Math.max(maxLift, 1.5)]).range([0, w]);
    const y = d3.scaleBand().domain(items.map(d => d.key)).range([0, h]).padding(0.18);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`)
        .call(d3.axisBottom(x).ticks(5).tickFormat(d => d + "x"));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y));

    // Baseline line at lift=1
    svg.append("line")
        .attr("x1", x(1)).attr("x2", x(1))
        .attr("y1", -4).attr("y2", h + 4)
        .attr("stroke", "white").attr("stroke-opacity", 0.5)
        .attr("stroke-dasharray", "3 3");
    svg.append("text")
        .attr("x", x(1) + 4).attr("y", -4)
        .attr("font-size", 10).attr("fill", "var(--text-muted)")
        .text("baseline");

    svg.selectAll("rect.risk-bar")
        .data(items)
        .join("rect")
        .attr("class", d => "risk-bar " + (d.lift > 2 ? "high" : d.lift > 1.2 ? "med" : "low"))
        .attr("x", 0)
        .attr("y", d => y(d.key))
        .attr("width", d => x(d.lift))
        .attr("height", y.bandwidth())
        .attr("rx", 3)
        .on("mousemove", function (event, d) {
            const pct = (d.rate * 100).toFixed(2);
            const base = (baseline * 100).toFixed(2);
            showTip(`<strong>${d.key}</strong>
                <div class="tt-row"><span class="tt-k">Severe-crash rate</span><span>${pct}%</span></div>
                <div class="tt-row"><span class="tt-k">Baseline</span><span>${base}%</span></div>
                <div class="tt-row"><span class="tt-k">Lift</span><span>${d.lift.toFixed(2)}x</span></div>
                <div class="tt-row"><span class="tt-k">Sample size</span><span>${d3.format(",")(d.total)} crashes</span></div>`, event);
        })
        .on("mouseout", hideTip);

    svg.selectAll("text.lift-label")
        .data(items)
        .join("text")
        .attr("class", "bar-label")
        .attr("x", d => x(d.lift) + 6)
        .attr("y", d => y(d.key) + y.bandwidth() / 2 + 4)
        .text(d => d.lift.toFixed(2) + "x");
}


// ============================================================
// Hourly chart (bar by hour)
// ============================================================

function drawHourlyChart(data) {
    const container = d3.select("#hourly-chart");
    container.selectAll("*").remove();

    const sevSerious = state.catIndex.severity["Suspected Serious Injury"];
    const sevFatal = state.catIndex.severity["Fatal Injury"];

    const buckets = d3.range(24).map(h => ({ hour: h, total: 0, severe: 0 }));
    for (const c of data) {
        const b = buckets[c.hour];
        b.total++;
        if (c.severity === sevSerious || c.severity === sevFatal) b.severe++;
    }

    const rect = container.node().getBoundingClientRect();
    const margin = { top: 16, right: 12, bottom: 28, left: 40 };
    const w = rect.width - margin.left - margin.right;
    const h = 240 - margin.top - margin.bottom;
    const svg = container.append("svg")
        .attr("width", w + margin.left + margin.right)
        .attr("height", h + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand().domain(d3.range(24)).range([0, w]).padding(0.1);
    const y = d3.scaleLinear().domain([0, d3.max(buckets, b => b.total) || 1]).nice().range([h, 0]);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`)
        .call(d3.axisBottom(x).tickValues([0, 3, 6, 9, 12, 15, 18, 21]).tickFormat(d => d + ":00"));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d3.format("~s")));
    svg.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));

    svg.selectAll("rect.bar")
        .data(buckets).join("rect")
        .attr("class", "bar")
        .attr("x", d => x(d.hour))
        .attr("y", d => y(d.total))
        .attr("width", x.bandwidth())
        .attr("height", d => h - y(d.total))
        .attr("fill", d => d.total ? "#ed9a51" : "rgba(255,255,255,0.05)")
        .attr("rx", 2)
        .style("cursor", "pointer")
        .on("mousemove", function (event, d) {
            const rate = d.total ? (d.severe / d.total * 100).toFixed(2) + "%" : "\u2014";
            showTip(`<strong>${String(d.hour).padStart(2, "0")}:00\u2013${String(d.hour + 1).padStart(2, "0")}:00</strong>
                <div class="tt-row"><span class="tt-k">Crashes</span><span>${d3.format(",")(d.total)}</span></div>
                <div class="tt-row"><span class="tt-k">Severe + fatal</span><span>${d3.format(",")(d.severe)}</span></div>
                <div class="tt-row"><span class="tt-k">Severity rate</span><span>${rate}</span></div>`, event);
        })
        .on("mouseout", hideTip)
        .on("click", function (event, d) {
            state.filters.hourStart = d.hour;
            state.filters.hourEnd = d.hour + 1.0001;
            const fmt = h => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
            d3.select("#filter-time-start").property("value", fmt(d.hour));
            d3.select("#filter-time-end").property("value", fmt(d.hour + 1));
            render();
        });
}


// ============================================================
// Vehicle bar
// ============================================================

function drawVehicleBar(data) {
    const container = d3.select("#vehicle-bar");
    container.selectAll("*").remove();

    const counts = new Array(state.catList.vehicle.length).fill(0);
    for (const c of data) counts[c.vehicle]++;
    const items = state.catList.vehicle.map((name, i) => ({ name, value: counts[i], idx: i }))
        .filter(d => d.name !== "Unknown" && d.value > 0)
        .sort((a, b) => b.value - a.value);

    const rect = container.node().getBoundingClientRect();
    const margin = { top: 12, right: 40, bottom: 20, left: 100 };
    const w = rect.width - margin.left - margin.right;
    const h = Math.max(220, items.length * 26) - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", w + margin.left + margin.right)
        .attr("height", h + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleLinear().domain([0, d3.max(items, d => d.value) || 1]).nice().range([0, w]);
    const y = d3.scaleBand().domain(items.map(d => d.name)).range([0, h]).padding(0.18);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`)
        .call(d3.axisBottom(x).ticks(4).tickFormat(d3.format("~s")));
    svg.append("g").attr("class", "axis").call(d3.axisLeft(y));

    svg.selectAll("rect.bar").data(items).join("rect")
        .attr("class", "bar")
        .attr("x", 0).attr("y", d => y(d.name))
        .attr("height", y.bandwidth())
        .attr("width", d => x(d.value))
        .attr("fill", d => state.filters.vehicle.has(d.idx) ? "#22d3ee" : "#a78bfa")
        .attr("rx", 3)
        .style("cursor", "pointer")
        .on("mousemove", function (event, d) {
            const pct = data.length ? (d.value / data.length * 100).toFixed(1) : 0;
            showTip(`<strong>${d.name}</strong>
                <div class="tt-row"><span class="tt-k">Crashes</span><span>${d3.format(",")(d.value)}</span></div>
                <div class="tt-row"><span class="tt-k">Share</span><span>${pct}%</span></div>`, event);
        })
        .on("mouseout", hideTip)
        .on("click", function (event, d) {
            if (state.filters.vehicle.has(d.idx)) state.filters.vehicle.delete(d.idx);
            else state.filters.vehicle.add(d.idx);
            render();
        });

    svg.selectAll("text.val").data(items).join("text")
        .attr("class", "bar-label")
        .attr("x", d => x(d.value) + 5)
        .attr("y", d => y(d.name) + y.bandwidth() / 2 + 4)
        .text(d => d3.format(",")(d.value));
}


// ============================================================
// Insights panel
// ============================================================

// Cache baseline rates (computed once over the whole dataset)
let baselineCache = null;
function getBaselines() {
    if (baselineCache) return baselineCache;
    const sevSerious = state.catIndex.severity["Suspected Serious Injury"];
    const sevFatal = state.catIndex.severity["Fatal Injury"];
    let severeN = 0, fatalN = 0;
    const subBad = new Set(["Alcohol", "Drug", "Combined", "Alcohol + Drug suspected"]
        .map(s => state.catIndex.substance[s]));
    let subN = 0;
    const distNot = state.catIndex.distraction["Not Distracted"];
    const distUnk = state.catIndex.distraction["Unknown"];
    let distYes = 0, distKnown = 0;
    for (const c of state.crashes) {
        if (c.severity === sevSerious || c.severity === sevFatal) severeN++;
        if (c.severity === sevFatal) fatalN++;
        if (subBad.has(c.substance)) subN++;
        if (c.distraction !== distUnk) {
            distKnown++;
            if (c.distraction !== distNot) distYes++;
        }
    }
    const total = state.crashes.length;
    baselineCache = {
        sevRate: severeN / total,
        fatalRate: fatalN / total,
        substanceRate: subN / total,
        distractionRate: distKnown ? distYes / distKnown : 0,
    };
    return baselineCache;
}

function drawInsights(data) {
    const list = d3.select("#insights");
    list.selectAll("*").remove();
    if (data.length === 0) {
        list.append("li").attr("class", "insight-item")
            .text("No crashes match the current filter. Try removing a filter.");
        return;
    }

    const fmt = d3.format(",");
    const pct = v => (v * 100).toFixed(2) + "%";
    const totalAll = state.crashes.length;
    const totalNow = data.length;
    const base = getBaselines();
    const insights = [];

    // 1. Selection summary
    insights.push({
        cls: "",
        html: `<strong>${fmt(totalNow)}</strong> crashes selected &mdash; ${(totalNow / totalAll * 100).toFixed(1)}% of the ${fmt(totalAll)} total between ${state.summary.year_min} and ${state.summary.year_max}.`,
    });

    // 2. Peak hour
    const byHour = new Array(24).fill(0);
    const byDow = new Array(7).fill(0);
    const byMonth = new Array(12).fill(0);
    const byYear = {};
    const collCounts = new Array(state.catList.collision.length).fill(0);
    const wCounts = new Array(state.catList.weather.length).fill(0);
    const lCounts = new Array(state.catList.light.length).fill(0);
    const sevSerious = state.catIndex.severity["Suspected Serious Injury"];
    const sevFatal = state.catIndex.severity["Fatal Injury"];
    let severeN = 0, fatalN = 0;
    const subBad = new Set(["Alcohol", "Drug", "Combined", "Alcohol + Drug suspected"]
        .map(s => state.catIndex.substance[s]));
    let subN = 0;
    const distNot = state.catIndex.distraction["Not Distracted"];
    const distUnk = state.catIndex.distraction["Unknown"];
    let distYes = 0, distKnown = 0;

    for (const c of data) {
        byHour[c.hour]++;
        byDow[c.dow]++;
        byMonth[c.month - 1]++;
        byYear[c.year] = (byYear[c.year] || 0) + 1;
        collCounts[c.collision]++;
        wCounts[c.weather]++;
        lCounts[c.light]++;
        if (c.severity === sevSerious || c.severity === sevFatal) severeN++;
        if (c.severity === sevFatal) fatalN++;
        if (subBad.has(c.substance)) subN++;
        if (c.distraction !== distUnk) {
            distKnown++;
            if (c.distraction !== distNot) distYes++;
        }
    }

    const peakHour = d3.maxIndex(byHour);
    insights.push({
        cls: "",
        html: `Peak hour is <strong>${String(peakHour).padStart(2, "0")}:00\u2013${String((peakHour + 1) % 24).padStart(2, "0")}:00</strong> &mdash; ${fmt(byHour[peakHour])} crashes (${(byHour[peakHour] / totalNow * 100).toFixed(1)}%).`,
    });

    const peakDow = d3.maxIndex(byDow);
    insights.push({
        cls: "",
        html: `Most crashes happen on <strong>${DOW_LABELS[peakDow]}</strong> (${fmt(byDow[peakDow])}, ${(byDow[peakDow] / totalNow * 100).toFixed(1)}%).`,
    });

    const topColl = d3.maxIndex(collCounts);
    const topCollName = state.catList.collision[topColl];
    if (topCollName !== "Unknown") {
        insights.push({
            cls: "",
            html: `The most common collision type is <strong>${topCollName}</strong> (${fmt(collCounts[topColl])}, ${(collCounts[topColl] / totalNow * 100).toFixed(1)}%).`,
        });
    }

    // 5. Severity rate vs baseline (LIFT)
    const sevRate = severeN / totalNow;
    const lift = sevRate / (base.sevRate || 0.001);
    insights.push({
        cls: lift > 1.5 ? "danger" : lift > 1.1 ? "warn" : lift < 0.8 ? "good" : "",
        html: `<strong>${pct(sevRate)}</strong> of these crashes are serious or fatal &mdash; ${lift.toFixed(2)}x the overall ${pct(base.sevRate)} baseline.`,
    });

    // 6. Substance vs baseline
    const subRate = subN / totalNow;
    const subLift = subRate / (base.substanceRate || 0.001);
    insights.push({
        cls: subLift > 1.5 ? "danger" : subLift > 1.1 ? "warn" : "",
        html: `Alcohol or drugs were suspected in <strong>${pct(subRate)}</strong> of these crashes &mdash; ${subLift.toFixed(2)}x the overall ${pct(base.substanceRate)} baseline.`,
    });

    // 7. Light split
    const dayIdx = state.catIndex.light["Daylight"];
    const darkIdx = state.catIndex.light["Dark - Lighted"];
    const darkUnlitIdx = state.catIndex.light["Dark - Unlit"];
    const darkN = (lCounts[darkIdx] || 0) + (lCounts[darkUnlitIdx] || 0);
    insights.push({
        cls: "",
        html: `<strong>${(lCounts[dayIdx] / totalNow * 100).toFixed(1)}%</strong> happened in daylight, <strong>${(darkN / totalNow * 100).toFixed(1)}%</strong> in the dark.`,
    });

    // 8. Rain/snow share
    const rainIdx = state.catIndex.weather["Rain"];
    const snowIdx = state.catIndex.weather["Snow"];
    const badWN = (wCounts[rainIdx] || 0) + (wCounts[snowIdx] || 0);
    insights.push({
        cls: "",
        html: `Rain or snow was present in <strong>${(badWN / totalNow * 100).toFixed(1)}%</strong> of these crashes.`,
    });

    // 9. Year trend (only when not filtered to a single year)
    if (state.filters.years.size === 0) {
        const yEntries = Object.entries(byYear).map(([k, v]) => [+k, v]).sort((a, b) => a[0] - b[0]);
        if (yEntries.length >= 3) {
            const yFirst = yEntries[0];
            const yLast = yEntries[yEntries.length - 1];
            // skip the last year if it ends mid-year and has notably fewer entries
            const useLast = yEntries[yEntries.length - 2];
            const delta = (useLast[1] - yFirst[1]) / yFirst[1] * 100;
            insights.push({
                cls: Math.abs(delta) > 15 ? "warn" : "",
                html: `From <strong>${yFirst[0]}</strong> to <strong>${useLast[0]}</strong>, total crashes ${delta >= 0 ? "rose" : "fell"} by <strong>${Math.abs(delta).toFixed(1)}%</strong> (${fmt(yFirst[1])} \u2192 ${fmt(useLast[1])}).`,
            });
        }
    }

    list.selectAll("li")
        .data(insights)
        .join("li")
        .attr("class", d => "insight-item " + (d.cls || ""))
        .html(d => d.html);
}


// ============================================================
// Boot
// ============================================================

window.addEventListener("resize", () => {
    if (filteredCache && filteredCache.length !== undefined) render();
});

loadAll().catch(err => {
    console.error(err);
    d3.select("#loading-overlay .loader-text").text("Failed to load data: " + err.message);
});
