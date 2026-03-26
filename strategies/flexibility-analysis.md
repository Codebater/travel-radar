# Fare Flexibility & Risk Analysis Strategy

Understanding fare flexibility prevents costly mistakes. A $200 "cheap" non-refundable ticket that needs changing can cost $400+ after change fees, while a $350 flexible fare would have been cheaper overall.

## Fare Class Flexibility Tiers

### Tier 1: Fully Flexible (F, A, P, J, Y)
- Full refund (no penalty)
- Free changes (same cabin)
- Name changes sometimes possible
- Maximum mileage earning
- **Best for**: Uncertain travel dates, business trips

### Tier 2: Semi-Flexible (C, D, B, M, H, K, W)
- Changes allowed with fee ($75-200) or fare difference
- Refund as travel credit (not cash)
- Good mileage earning
- **Best for**: Likely to travel, small chance of change

### Tier 3: Restricted (I, Z, L, V, S, U, T)
- High change fees ($200+) plus fare difference
- No refund (maybe credit with penalty)
- Reduced mileage earning
- **Best for**: Certain travel, budget-conscious

### Tier 4: Basic Economy (N, Q, O, G, E, X)
- No changes permitted
- No refund
- No seat selection
- Last to board, no overhead bin (some carriers)
- Minimal or no mileage earning
- **Best for**: Absolutely certain travel, price-only decision

## Risk Calculation Framework

```
Expected Cost = Ticket Price + (Probability of Change × Change Cost)

Example A: Basic Economy $200, 20% chance of change
  $200 + (0.20 × $200 cancel penalty) = $240 expected cost

Example B: Flexible Economy $350, 20% chance of change
  $350 + (0.20 × $0 change fee) = $350 expected cost

Break-even: When is flexible worth it?
  $350 - $200 = $150 premium for flexibility
  $150 / $200 penalty = 75% change probability needed
  → If >75% likely to change, buy flexible
  → If <75% likely to change, buy basic (statistically)
```

## Airline-Specific Policies (2026)

### Change Fees Eliminated (COVID era changes, still in effect)
- **United**: No change fees on most domestic fares (except basic economy)
- **Delta**: No change fees on domestic main cabin and above
- **American**: No change fees on domestic main cabin and above
- **Alaska**: No change fees
- **JetBlue**: No change fees on Blue, Blue Plus
- **Southwest**: Never had change fees

### Change Fees Still Apply
- **Spirit**: $69-119 depending on timing
- **Frontier**: $49-99
- **International flights**: Most carriers still charge $200-400
- **Basic economy**: All carriers charge or prohibit changes

## 24-Hour Rule (DOT Regulation)

US DOT requires airlines to offer either:
1. Free cancellation within 24 hours of booking, OR
2. Hold the fare for 24 hours without payment

This applies to:
- All flights departing from the US
- Bookings made 7+ days before departure
- Direct airline bookings (OTAs may not honor)

**Strategy**: Book now, research later. Cancel within 24 hours if you find better.

## Implementation

PocketWatch's `analyze_fare_details` chat tool:
1. Reads the fare class from search results
2. Maps to flexibility tier using industry conventions + airline-specific overrides
3. Shows refundability, changeability, and estimated change fees
4. Estimates ancillary fees based on airline

The flight result card shows a color-coded badge:
- Green "Flex" = fully flexible
- Blue "Change OK" = semi-flexible
- Amber "Limited" = restricted
- Red "Basic" = no changes
