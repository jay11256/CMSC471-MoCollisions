const margin = { top: 40, right: 40, bottom: 100, left: 80 };
let width, height, svg;
let allData = [];

const parseTime = d3.timeParse("%m/%d/%Y %I:%M:%S %p");

// Basic data loading skeleton
d3.csv("data/Crash_Reporting.csv").then(data => {
    console.log("Data loaded:", data.length, "rows");

    // Hide loading, show visualization container to get width
    d3.select("#loading").style("display", "none");
    d3.select("#vis").style("display", "block");

    // Calculate dimensions now that container is visible
    const visContainer = document.querySelector('#vis');
    width = visContainer.clientWidth - margin.left - margin.right;
    height = 600 - margin.top - margin.bottom;

    // Initialize SVG
    svg = d3.select("#vis")
        .append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Process data
    allData = data.map(d => {
        const date = parseTime(d["Crash Date/Time"]);
        const rawSeverity = d["Injury Severity"] || "Unknown";
        const rawWeather = d["Weather"] || "Unknown";
        const rawLight = d["Light"] || "Unknown";
        let normalizedLight = rawLight.trim().toUpperCase();
        if (normalizedLight.startsWith("DARK")) normalizedLight = "DARK";

        return {
            ...d,
            date: date,
            hour: date ? date.getHours() : null,
            day: date ? date.getDay() : null,
            month: date ? date.getMonth() : null,
            weather: rawWeather.trim().toUpperCase(),
            light: normalizedLight,
            severity: rawSeverity.trim().toUpperCase()
        };
    }).filter(d => d.date !== null);

    populateFilters(allData);
    bindTimeRangeSliders();
    applyFilters(); // Initial render

}).catch(error => {
    console.error("Error loading data:", error);
});

function formatHour12(h) {
    const period = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:00 ${period}`;
}

function updateTimeRangeUI() {
    const s = +d3.select("#filter-time-start").property("value");
    const e = +d3.select("#filter-time-end").property("value");
    d3.select("#time-range-label").text(`${formatHour12(s)} – ${formatHour12(e)}`);

    const pctLeft = (s / 23) * 100;
    const pctWidth = ((e - s) / 23) * 100;
    const minFillPct = e === s ? 1.2 : 0.35;
    d3.select("#time-range-fill")
        .style("left", pctLeft + "%")
        .style("width", Math.max(pctWidth, minFillPct) + "%");

    const distLeft = s;
    const distRight = 23 - e;
    d3.select("#filter-time-start").style("z-index", distLeft <= distRight ? 4 : 3);
    d3.select("#filter-time-end").style("z-index", distRight < distLeft ? 4 : 3);
}

function bindTimeRangeSliders() {
    d3.select("#filter-time-start").on("input", function () {
        let s = +this.value;
        const endSel = d3.select("#filter-time-end");
        let e = +endSel.property("value");
        if (s > e) endSel.property("value", s);
        updateTimeRangeUI();
        applyFilters();
    });
    d3.select("#filter-time-end").on("input", function () {
        let e = +this.value;
        const startSel = d3.select("#filter-time-start");
        let s = +startSel.property("value");
        if (e < s) startSel.property("value", e);
        updateTimeRangeUI();
        applyFilters();
    });
    updateTimeRangeUI();
}

function populateFilters(data) {
    const weathers = [...new Set(data.map(d => d.weather))].sort();
    const lights = [...new Set(data.map(d => d.light))].sort();

    const weatherContainer = d3.select("#filter-weather-container");
    weathers.forEach((w, i) => {
        if (!w) return;
        const id = `w-${i}`;
        const div = weatherContainer.append("div").attr("class", "form-check");
        div.append("input")
            .attr("class", "form-check-input")
            .attr("type", "checkbox")
            .attr("value", w)
            .attr("id", id)
            .on("change", applyFilters);
        div.append("label")
            .attr("class", "form-check-label")
            .attr("for", id)
            .text(w);
    });

    const lightContainer = d3.select("#filter-light-container");
    lights.forEach((l, i) => {
        if (!l) return;
        const id = `l-${i}`;
        const div = lightContainer.append("div").attr("class", "form-check");
        div.append("input")
            .attr("class", "form-check-input")
            .attr("type", "checkbox")
            .attr("value", l)
            .attr("id", id)
            .on("change", applyFilters);
        div.append("label")
            .attr("class", "form-check-label")
            .attr("for", id)
            .text(l);
    });

    d3.selectAll("#filter-day-container input, #filter-month-container input").on("change", applyFilters);
}

function applyFilters() {
    if (!allData.length) return;

    const hourLo = +d3.select("#filter-time-start").property("value");
    const hourHi = +d3.select("#filter-time-end").property("value");

    const selectedDays = [];
    d3.selectAll("#filter-day-container input:checked").each(function () { selectedDays.push(this.value); });

    const selectedMonths = [];
    d3.selectAll("#filter-month-container input:checked").each(function () { selectedMonths.push(+this.value); });

    const selectedWeather = [];
    d3.selectAll("#filter-weather-container input:checked").each(function () { selectedWeather.push(this.value); });

    const selectedLight = [];
    d3.selectAll("#filter-light-container input:checked").each(function () { selectedLight.push(this.value); });

    const filtered = allData.filter(d => {
        const timeMatch = d.hour >= hourLo && d.hour <= hourHi;
        const dayMatch = selectedDays.length === 0 || selectedDays.includes(d.day.toString());
        const monthMatch = selectedMonths.length === 0 || selectedMonths.includes(d.month);
        const weatherMatch = selectedWeather.length === 0 || selectedWeather.includes(d.weather);
        const lightMatch = selectedLight.length === 0 || selectedLight.includes(d.light);
        return timeMatch && dayMatch && monthMatch && weatherMatch && lightMatch;
    });

    updateVisualization(filtered);
}

const SEVERITY_ORDER = [
    "NO APPARENT INJURY",
    "POSSIBLE INJURY",
    "SUSPECTED MINOR INJURY",
    "SUSPECTED SERIOUS INJURY",
    "FATAL INJURY"
];

function updateVisualization(data) {
    if (!svg) return;

    const counts = d3.rollup(data, v => v.length, d => d.severity);

    // Ensure all categories are present, even if count is 0
    const plotData = SEVERITY_ORDER.map(severity => ({
        severity: severity,
        count: counts.get(severity) || 0
    }));

    // Handle any extra categories not in the main order if they exist
    counts.forEach((count, severity) => {
        if (!SEVERITY_ORDER.includes(severity) && severity !== "UNKNOWN") {
            plotData.push({ severity, count });
        }
    });

    const noInjuryCount = counts.get("NO APPARENT INJURY") || 0;

    const x = d3.scaleBand()
        .domain(plotData.map(d => d.severity))
        .range([0, width])
        .padding(0.3);

    const y = d3.scaleLinear()
        .domain([0, noInjuryCount || 10])
        .range([height, 0]);

    svg.selectAll(".axis").remove();

    svg.append("g")
        .attr("class", "axis x-axis")
        .attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(x))
        .selectAll("text")
        .style("text-anchor", "end")
        .attr("dx", "-.8em")
        .attr("dy", ".15em")
        .attr("transform", "rotate(-35)");

    svg.append("g")
        .attr("class", "axis y-axis")
        .call(d3.axisLeft(y).ticks(10, "s"));

    svg.selectAll(".axis-title").remove();
    svg.append("text")
        .attr("class", "axis-title axis-label")
        .attr("x", width / 2)
        .attr("y", height + margin.bottom - 10)
        .attr("text-anchor", "middle")
        .text("Injury Severity");

    svg.append("text")
        .attr("class", "axis-title axis-label")
        .attr("transform", "rotate(-90)")
        .attr("x", -height / 2)
        .attr("y", -margin.left + 15)
        .attr("text-anchor", "middle")
        .text("Number of Accidents");

    const bars = svg.selectAll(".bar")
        .data(plotData, d => d.severity);

    bars.exit()
        .transition()
        .duration(500)
        .attr("y", height)
        .attr("height", 0)
        .remove();

    const barsEnter = bars.enter()
        .append("rect")
        .attr("class", "bar")
        .attr("x", d => x(d.severity))
        .attr("y", height)
        .attr("width", x.bandwidth())
        .attr("height", 0)
        .attr("rx", 4);

    barsEnter.merge(bars)
        .transition()
        .duration(750)
        .attr("x", d => x(d.severity))
        .attr("y", d => d.count > 0 ? Math.min(y(d.count), height - 2) : y(d.count))
        .attr("width", x.bandwidth())
        .attr("height", d => d.count > 0 ? Math.max(2, height - y(d.count)) : 0);

    // Labels
    const labels = svg.selectAll(".bar-label")
        .data(plotData, d => d.severity);

    labels.exit().remove();

    const labelsEnter = labels.enter()
        .append("text")
        .attr("class", "bar-label")
        .attr("text-anchor", "middle")
        .attr("x", d => x(d.severity) + x.bandwidth() / 2)
        .attr("y", height)
        .style("opacity", 0);

    labelsEnter.merge(labels)
        .transition()
        .duration(750)
        .attr("x", d => x(d.severity) + x.bandwidth() / 2)
        .attr("y", d => (d.count > 0 ? Math.min(y(d.count), height - 2) : y(d.count)) - 5)
        .text(d => d.count > 0 ? d3.format(",")(d.count) : "")
        .style("opacity", 1);

    const tooltip = d3.select("#tooltip");

    svg.selectAll(".bar")
        .on("mouseover", function (event, d) {
            d3.select(this).style("fill", "#6366f1");
            tooltip.transition().duration(200).style("opacity", 1);
            tooltip.html(`<strong>${d.severity}</strong><br/>Count: ${d3.format(",")(d.count)}`)
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 28) + "px");
        })
        .on("mousemove", function (event) {
            tooltip.style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 28) + "px");
        })
        .on("mouseout", function () {
            d3.select(this).style("fill", null);
            tooltip.transition().duration(500).style("opacity", 0);
        });
}
