# Synthetic statement layouts (P4)

The FOP importer (`js/cost_basis_fop_import.js`) and the server's row reader
(`cost_basis_fop_statement.py`) are tested on statements that
`tests/helpers/cost_basis_fop_statements.js` writes from lists of fills. The
tests generate them; none is stored here. **No real statement was used.**
Every economic row type therefore stays `synthetic_only` in
`cost_basis_fop_capabilities.json` (plan §9.7): it can be previewed, and
written only as a manual claim, until a de-identified real sample accepts it.

The layouts below come from the plan and from the stock importer's verified
Activity and Flex exports (`js/cost_basis_import.js`). The FOP and FUT parts
are assumptions that a real sample has to confirm field by field.

## Activity Statement (`activity_csv`)

Every row starts with its section name and `Header` or `Data`. A section may
repeat its header with another layout; rows belong to the header in force.

| Section | Header (after the first two cells) | Read as |
| --- | --- | --- |
| `Statement` | `Field Name, Field Value` | `Period` (`October 1, 2026 - October 31, 2026`), `WhenGenerated` (`2027-03-01, 09:15:00 EST`: the abbreviation names the account timezone when it names exactly one zone) |
| `Account Information` | `Field Name, Field Value` | `Account` (exact, or masked `U****1111` confirmed per file) |
| `Trades` | `DataDiscriminator, Asset Category, Currency, Symbol, Date/Time, Quantity, T. Price, Proceeds, Comm/Fee, Code` | one row per fill; `Order` rows sum their `Trade` (execution) rows, and executions are imported when present; `ClosedLot` rows repeat a trade and are listed only; a row of any other kind blocks |
| `Financial Instrument Information` | `Asset Category, Symbol, Description, Conid, Underlying, Listing Exch, Multiplier, Expiry, Delivery Month, Type, Strike, Settlement Type, Code` | contract evidence: a future's `Delivery Month` (`2026-12`) and last trade date (`Expiry`); an option's underlying future, right, strike and expiry |
| `Open Positions` | `DataDiscriminator, Asset Category, Currency, Symbol, Quantity, Mult, Cost Price, Close Price` | quantity proof: opening = closing - net change in the period |
| `Cash Report`, `Mark-to-Market Performance Summary`, `Statement of Funds` | any | out of scope (plan §6.3): listed, never written, never blocking |

Asset categories: `Futures` (FUT) and `Options On Futures` (FOP), or the
Chinese `期货` and `期货期权`. The Chinese Trades header names both the
contract and the notes column `代码`; the first is the symbol and the second
the codes. `Date/Time` is the execution time on the account clock; an
Activity Statement prints no exchange trade date.

Codes: `O` open, `C` close, `A` assignment, `Ex` exercise, `Ep` expiry. An
assignment or exercise is the option row (quantity closing, price 0) and the
future row at the strike, at the same time; either without the other blocks.

Rows in one second are listed in no proven order: a statement sorts its rows,
so their order is never read as the execution order.

## Flex trades export (`flex_csv`)

One flat table: `ClientAccountID, CurrencyPrimary, AssetClass, Symbol,
Description, Conid, UnderlyingConid, UnderlyingSymbol, Multiplier, Strike,
Expiry, Put/Call, TradeID, IBExecID, IBOrderID, DateTime, TradeDate, Quantity,
TradePrice, Proceeds, IBCommission, Notes/Codes, ListingExchange`.

- `DateTime` (`20261001;190000`) is the execution time on the account clock;
  `TradeDate` is the exchange trade date, which a night session moves to the
  next day. Without `DateTime` the row covers its trade date from the evening
  session before it, in the exchange timezone.
- `TradeID` is the row's reference (`flex_trade`); a row with only `IBExecID`
  uses that (`ib_exec`). `IBExecID` also matches a TWS execution to supersede.
- `IBOrderID` names the broker order. An order-level row and its executions
  are the same fill only when both name the same order; two rows naming
  different orders are two fills.
- `Expiry` of a future is its last trade date, never its delivery month; the
  delivery month comes from the local symbol (`CLZ6`) read against the trade
  date.
- The export prints no period: coverage is the dates its rows span.
