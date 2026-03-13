# Portfolio Rebalancer Tool — Setup Guide

## Purpose

This guide explains how to use the Portfolio Rebalancer project page to calculate buy/sell trades that return holdings to target weights.

## Inputs

Enter one position per line in this format:

`Asset, Current Value, Target Weight %`

Example:

`US Equity,45000,50`

## Steps

1. Open the Portfolio Rebalancer Tool page.
2. Paste or type all positions into the input box.
3. Enter net contribution/withdrawal:
   - Positive = contribution
   - Negative = withdrawal
4. Click **Calculate Rebalance**.
5. Review the generated trade table and post-trade allocation values.

## Validation Rules

- Each line must contain exactly 3 comma-separated values.
- Current value must be numeric and non-negative.
- Target weight must be numeric and greater than 0.
- Ending portfolio value must remain above 0.

## Output

The tool returns:

- Total current value
- Net flow
- Target ending value
- Trade-by-asset instructions (buy/sell)
- Post-trade asset values
