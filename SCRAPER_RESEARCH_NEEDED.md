# Scraper Research Tasks

This document outlines what needs to be researched and implemented for each airline scraper.

## Current Status

### ✅ Working Scrapers
- **United**: Working but slow (45+ seconds to complete)

### 🔴 Broken Scrapers  
- **Alaska**: API changed, now returns HTML instead of JSON from `/searchbff/V3/search`
- **Aeroplan**: Times out waiting for API response, likely endpoint changed

### 🚧 New Scrapers (Need Research)

#### Air France / Flying Blue
- **File**: `awardwiz-scrapers/scrapers/airfrance.ts`
- **Status**: Skeleton created, needs API research
- **TODO**: 
  - Find the actual API endpoint used by airfrance.com or flyingblue.com
  - Research authentication requirements
  - Update URL pattern and response parsing
  - Test with LAX → DXB route

#### British Airways
- **File**: `awardwiz-scrapers/scrapers/britishairways.ts` 
- **Status**: Skeleton created, needs API research
- **TODO**:
  - Find BA Executive Club award search API endpoint
  - Handle Avios vs Miles conversion
  - Research if login is required for award searches
  - Update URL pattern and response parsing
  - Test with LAX → DXB route

#### Qatar Airways
- **File**: `awardwiz-scrapers/scrapers/qatarairways.ts`
- **Status**: Skeleton created, needs API research  
- **TODO**:
  - Find QR Privilege Club award search API endpoint
  - Research Qmiles to standard miles conversion
  - Update URL pattern and response parsing
  - Test with LAX → DXB route (QR hub in DOH)

#### Emirates
- **File**: `awardwiz-scrapers/scrapers/emirates.ts`
- **Status**: Skeleton created, needs API research
- **TODO**:
  - Find Emirates Skywards award search API endpoint  
  - Research Skywards miles conversion
  - Handle Emirates premium products (First suites, etc.)
  - Update URL pattern and response parsing
  - Test with LAX → DXB route (Emirates hub in DXB)

## Research Process

For each airline, follow this process:

1. **Manual Browser Testing**:
   ```bash
   # Use browser tool to navigate to award search page
   browser action=open targetUrl="https://[airline].com/award-search"
   # Perform search: LAX → DXB, Apr 28 2026, 1 passenger  
   # Check Network tab for API calls
   ```

2. **Find API Endpoint**:
   - Look for XHR/Fetch requests in DevTools Network tab
   - Note URL pattern, request headers, POST body
   - Check response format and structure

3. **Update Scraper Code**:
   - Update URL construction in scraper
   - Update `arkalis.waitFor()` patterns
   - Update response type definitions
   - Implement `standardizeResults()` function

4. **Test Scraper**:
   ```bash
   cd ~/Projects/awardwiz
   npx tsx cli.ts search -f LAX -t DXB -d 2026-04-28 -p [airline]
   ```

## Fixing Broken Scrapers

### Alaska Airlines
- **Issue**: `/searchbff/V3/search` endpoint now returns HTML  
- **Solution**: Find new API endpoint used by current alaskaair.com
- **Research needed**: Navigate to alaskaair.com, search LAX→DXB, find actual API call

### Aeroplan  
- **Issue**: Times out waiting for API response
- **Solution**: Update API endpoint or request pattern
- **Research needed**: Test aircanada.com award search, check for new endpoint

## Testing Route
For consistency, test all scrapers with:
- **Origin**: LAX (Los Angeles)
- **Destination**: DXB (Dubai)  
- **Date**: 2026-04-28
- **Passengers**: 1 adult
- **Cabin**: All (economy, business, first)

This route is:
- International long-haul (good test case)
- Served by most major carriers
- Has good award availability typically
- DXB is a major hub for Emirates (good for testing)