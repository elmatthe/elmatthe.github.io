# Portfolio Rebalancer Tool — Setup Guide

## Purpose

This guide explains how to use the Portfolio Rebalancer project page to calculate buy/sell trades that return holdings to target weights.

## Inputs

Use the input table on the page:

- **Ticker** (example: `AAPL`, `VTI`)
- **Shares / Units held**
- **Price (USD)** per share/unit
- **Target Weight %**

Choose the number of securities using **Number of securities** and click **Apply Rows**.

## Steps

1. Open the Portfolio Rebalancer Tool page.
2. Set the number of securities held.
3. Fill the table rows (ticker, shares, price, target weight).
4. Enter net contribution/withdrawal:
   - Positive = contribution
   - Negative = withdrawal
5. Click **Run Rebalance**.
6. Review the generated output table and strategy:
   - Current value vs target value by ticker
   - Buy/sell dollar amount per ticker
   - Shares/units to buy or sell
   - Post-trade shares/units

## Validation Rules

- Ticker is required in every row.
- Shares/units must be numeric and non-negative.
- Price must be numeric and greater than 0.
- Target weight must be numeric and 0 or greater.
- At least one row must have a target weight greater than 0.
- Ending portfolio value must remain above 0.

## Output

The tool returns:

- Total current value
- Net flow
- Target ending value
- Total buy and sell value
- Trade-by-ticker instructions (buy/sell)
- Shares/units to trade and post-trade holdings
