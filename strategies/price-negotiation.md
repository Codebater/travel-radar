# Price Negotiation & Match Strategy

Airlines rarely advertise price matching, but many have policies or customer service discretion to match or beat competitor fares. This strategy generates persuasive price match emails using real search data.

## Which Airlines Price Match

### Formal Price Match Policies
- **Southwest**: Automatic refund of difference if price drops after booking
- **JetBlue**: No formal policy, but customer service often accommodates
- **Alaska**: Fare guarantee — refunds difference within 24 hours of booking

### Informal / Discretion-Based
- **Delta**: Will sometimes match via Twitter DM or phone
- **United**: Rarely matches, but may offer vouchers
- **American**: Almost never matches competitors

### Best Channels
1. **Twitter/X DMs**: Fastest response, agents have more discretion
2. **Phone**: Call loyalty/elite lines if you have status
3. **Email**: Slowest but creates a paper trail
4. **Chat**: Some airlines have live chat with booking authority

## Email Template Elements

An effective price match email includes:
1. **Specific competitor fare** with airline, route, date, and price
2. **Your loyalty status** or history with the target airline
3. **Willingness to book immediately** if they match
4. **Polite but firm tone** — not demanding, but showing you have options

## When Price Matching Works Best

- Within 24 hours of finding the competitor fare
- When the price difference is significant ($100+)
- When you have loyalty status with the target airline
- On routes where the target airline has competition
- During off-peak periods when airlines want to fill seats

## When It Doesn't Work

- Basic economy vs full economy comparison (different products)
- ULCC vs legacy carrier comparison (different service levels)
- Award ticket pricing (points aren't price-matched)
- Sale fares that have already ended
- International fares with different routing

## Implementation

PocketWatch's `generate_price_match_email` chat tool:
1. Finds the cheapest cash fare from the user's search results
2. Identifies the target airline (user-specified or most expensive)
3. Drafts a professional email with all competitor details pre-filled
4. Includes tips on timing and channel selection
