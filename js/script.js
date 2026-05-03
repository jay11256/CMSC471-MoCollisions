const margin = { top: 40, right: 40, bottom: 60, left: 60 };
const width = document.querySelector('#vis').clientWidth - margin.left - margin.right;
const height = 600 - margin.top - margin.bottom;

const svg = d3.select("#vis")
    .append("svg")
    .attr("width", width + margin.left + margin.right)
    .attr("height", height + margin.top + margin.bottom)
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

const parseTime = d3.timeParse("%m/%d/%Y %I:%M:%S %p");

let allData = [];

// Basic data loading skeleton
d3.csv("data/Crash_Reporting.csv").then(data => {
    console.log("Data loaded:", data.length, "rows");
    
    // Process data
    allData = data.map(d => {
        const date = parseTime(d["Crash Date/Time"]);
        return {
            ...d,
            date: date,
            hour: date ? date.getHours() : null,
            day: date ? date.getDay() : null,
            month: date ? date.getMonth() : null,
            weather: d["Weather"],
            light: d["Light"]
        };
    }).filter(d => d.date !== null); // Remove rows with invalid dates

    populateFilters(allData);
    updateVisualization(allData);

    // Hide loading, show visualization
    d3.select("#loading").style("display", "none");
    d3.select("#vis").style("display", "block");

    // Add event listeners
    d3.selectAll(".custom-select").on("change", () => {
        applyFilters();
    });

}).catch(error => {
    console.error("Error loading data:", error);
});

function populateFilters(data) {
    const weathers = [...new Set(data.map(d => d.weather))].sort();
    const lights = [...new Set(data.map(d => d.light))].sort();

    const weatherSelect = d3.select("#filter-weather");
    weathers.forEach(w => {
        if (w) weatherSelect.append("option").text(w).attr("value", w);
    });

    const lightSelect = d3.select("#filter-light");
    lights.forEach(l => {
        if (l) lightSelect.append("option").text(l).attr("value", l);
    });
}

function applyFilters() {
    const timeVal = d3.select("#filter-time").property("value");
    const dayVal = d3.select("#filter-day").property("value");
    const monthVal = d3.select("#filter-month").property("value");
    const weatherVal = d3.select("#filter-weather").property("value");
    const lightVal = d3.select("#filter-light").property("value");

    const filtered = allData.filter(d => {
        // Time of Day Filter
        let timeMatch = true;
        if (timeVal === "morning") timeMatch = d.hour >= 6 && d.hour < 12;
        else if (timeVal === "afternoon") timeMatch = d.hour >= 12 && d.hour < 18;
        else if (timeVal === "evening") timeMatch = d.hour >= 18 && d.hour < 24;
        else if (timeVal === "night") timeMatch = d.hour >= 0 && d.hour < 6;

        // Day of Week Filter
        let dayMatch = true;
        if (dayVal === "weekday") dayMatch = d.day >= 1 && d.day <= 5;
        else if (dayVal === "weekend") dayMatch = d.day === 0 || d.day === 6;

        // Month Filter
        let monthMatch = monthVal === "all" || d.month === +monthVal;

        // Weather Filter
        let weatherMatch = weatherVal === "all" || d.weather === weatherVal;

        // Light Filter
        let lightMatch = lightVal === "all" || d.light === lightVal;

        return timeMatch && dayMatch && monthMatch && weatherMatch && lightMatch;
    });

    updateVisualization(filtered);
}

function updateVisualization(data) {
    console.log("Updating visualization with", data.length, "rows");
    // Placeholder for visualization update logic
    // e.g., svg.selectAll(".dot").data(data)...
}
