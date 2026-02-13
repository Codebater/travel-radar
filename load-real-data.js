// Function to load and convert AwardWiz scraper results to dashboard format

async function loadScraperResults() {
  try {
    // Try to load results from AwardWiz
    const response = await fetch('./results.json');
    if (!response.ok) {
      console.log('No scraper results found, using estimated data');
      return null;
    }
    
    const scraperData = await response.json();
    console.log('Loaded real scraper data:', scraperData);
    
    return convertScraperDataToDashboard(scraperData);
  } catch (error) {
    console.log('Error loading scraper results:', error);
    return null;
  }
}

function convertScraperDataToDashboard(scraperData) {
  const dashboardData = {
    economy: { cash: [], award: [] },
    business: { cash: [], award: [] }
  };
  
  // Process each scraper result
  scraperData.scraperResults.forEach(result => {
    if (result.status === 'success' && result.flights.length > 0) {
      result.flights.forEach(flight => {
        // Convert each flight to dashboard format
        flight.fares.forEach(fare => {
          const dashboardFlight = {
            program: result.scraper.charAt(0).toUpperCase() + result.scraper.slice(1),
            airline: getAirlineFromFlightNo(flight.flightNo),
            miles: `${Math.round(fare.miles / 1000)}K`,
            taxes: fare.cash || 0,
            flyOn: `${getAirlineFromFlightNo(flight.flightNo)} ${getRouteDescription(flight)}`,
            cpp: calculateCpp(fare.miles, fare.cash, getEstimatedCashPrice(flight)),
            status: 'green', // Real scraped data is always available
            statusText: `Scraped from ${result.scraper}.com`,
            type: 'award',
            durationMin: flight.duration || 0,
            source: 'scraped', // Mark as real scraped data
            scraper: result.scraper,
            legs: [{
              dir: 'OUT',
              from: flight.origin,
              to: flight.destination,
              via: null, // TODO: Parse connections
              flights: flight.flightNo,
              depart: formatTime(flight.departureDateTime),
              arrive: formatTime(flight.arrivalDateTime),
              duration: formatDuration(flight.duration),
              cost: `${Math.round(fare.miles / 1000)}K ${result.scraper === 'united' ? 'miles' : 'points'} + $${fare.cash}`
            }]
          };
          
          // Add to appropriate cabin category
          const cabin = fare.cabin === 'business' || fare.cabin === 'first' ? 'business' : 'economy';
          dashboardData[cabin].award.push(dashboardFlight);
        });
      });
    }
  });
  
  return dashboardData;
}

function getAirlineFromFlightNo(flightNo) {
  const code = flightNo.split(' ')[0];
  const airlines = {
    'UA': 'United',
    'AS': 'Alaska', 
    'AC': 'Air Canada',
    'AF': 'Air France',
    'BA': 'British Airways',
    'QR': 'Qatar',
    'EK': 'Emirates'
  };
  return airlines[code] || code;
}

function getRouteDescription(flight) {
  // TODO: Parse connections for "via XXX" format
  return flight.origin === flight.destination ? 'Nonstop' : `${flight.origin} → ${flight.destination}`;
}

function calculateCpp(miles, taxes, estimatedCash) {
  if (!estimatedCash || miles === 0) return 0;
  return ((estimatedCash - taxes) / (miles / 100)).toFixed(1);
}

function getEstimatedCashPrice(flight) {
  // Rough estimates for CPP calculation
  // This would ideally come from cash price scrapers
  const estimates = {
    'economy': 800,   // Estimated LAX-DXB economy RT
    'business': 3500, // Estimated LAX-DXB business RT
    'first': 8000     // Estimated LAX-DXB first RT
  };
  return estimates['economy']; // Default to economy for now
}

function formatTime(datetime) {
  if (!datetime) return '';
  const date = new Date(datetime);
  return date.toLocaleDateString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    hour: 'numeric', 
    minute: '2-digit',
    hour12: true 
  });
}

function formatDuration(minutes) {
  if (!minutes) return '';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

// Export for use in dashboard
window.loadScraperResults = loadScraperResults;