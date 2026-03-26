# Ancillary Fee Breakdown Strategy

Airfare is never the true cost. Baggage fees, seat selection, and other extras can add $50-200+ per passenger. This strategy itemizes all fees to reveal the actual trip cost.

## Fee Categories

### Checked Baggage
| Carrier Type | First Bag | Second Bag | Notes |
|-------------|-----------|------------|-------|
| US Legacy (AA, UA, DL) | $35 | $45 | Free with elite status or credit card |
| Southwest | $0 | $0 | 2 free checked bags for all |
| US ULCC (Spirit, Frontier) | $40-55 | $55-65 | Cheaper if pre-purchased online |
| European Legacy (BA, LH, AF) | $0 (int'l) | $0 | Usually included on transatlantic |
| European ULCC (Ryanair, easyJet) | $25-40 | $40-55 | Gate fees much higher |
| Middle East/Asia (EK, SQ, QR) | $0 | $0 | Generous allowances included |

### Carry-On Bags
Most airlines include a carry-on for free. Exceptions:
- **Spirit**: $35-65 (gate = $65)
- **Frontier**: $35-60
- **Ryanair**: €10-25 (priority boarding includes)
- **Wizz Air**: €15-30

### Seat Selection
| Tier | Typical Cost | What You Get |
|------|-------------|--------------|
| Standard | $0-15 | Middle seats, back of plane |
| Preferred | $15-35 | Window/aisle, forward cabin |
| Extra legroom | $30-80 | Exit row, bulkhead |
| Assigned at check-in | $0 | Random — may separate groups |

## Cost Avoidance Strategies

### Credit Card Benefits
Many premium cards include free checked bags:
- **Delta SkyMiles Amex Gold**: Free first bag on Delta ($35 savings each way)
- **United Explorer Card**: Free first bag on United
- **Citi AAdvantage Platinum**: Free first bag on American
- **Southwest Rapid Rewards Plus**: Already free, but earns anniversary points

### Elite Status
All US legacy carriers give free checked bags to elite members:
- Silver/Gold = 1-2 free bags
- Platinum+ = 2-3 free bags + priority boarding

### Packing Light
- Personal item only (under-seat bag): always free on every airline
- Compression packing cubes can fit a week in a personal item
- Wear heaviest items on the plane

## True Cost Calculator

```
Advertised fare:              $199
+ Checked bag (each way):     $70  ($35 × 2)
+ Seat selection:             $30  ($15 × 2)
+ Priority boarding:          $20  ($10 × 2)
= TRUE COST:                  $319

Compare against:
Full-service carrier:         $349  (bag + seat included)
Net savings of "cheap" fare:  -$30  (actually more expensive!)
```

## Implementation Notes

For PocketWatch, the fee lookup uses a static per-airline matrix that estimates the most common fees. This is displayed as "est. +$X fees" on flight cards so users can compare true costs at a glance.

Data sources for keeping fees current:
- DOT baggage fee disclosure reports (annual)
- Airline fee pages (checked quarterly)
- Google Flights fee estimates (when available via SerpAPI)
