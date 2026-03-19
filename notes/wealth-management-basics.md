---
title: Wealth Management Basics (Living Notes)
layout: page
permalink: /notes/wealth-management-basics/
nav_order: 10
summary: A continually updated catalogue of fundamentals, checklists, and templates for practicing wealth managers in Canada.
tags: [notes, wealth-management, canada, basics, compliance, portfolio, planning]
last_updated: 2026-03-13
toc: true
---

# Wealth Management Basics (Living Notes)

> [!NOTE]
> Purpose: a concise, add-as-you-go reference for **process, compliance, planning, portfolio construction, tax-aware implementation, etc**.  
> Scope: written for Canada (RRSP, TFSA, FHSA, RESP, etc.). Avoid hard numbers here—link out or update annually.

**How to use this page**
- Treat each `###` section as a small module. Add examples, links, and your own checklists.
- Use `<!-- TODO: ... -->` to queue future additions.
- Keep all templates in the **Appendix** so you can re-use them anywhere on your site.

---

## Quick Start & Table of Contents

- [Core Framework & Process](#core-framework--process)
- [Compliance & Ethics (Canada)](#compliance--ethics-canada)
- [Client Discovery & IPS](#client-discovery--ips)
- [Cash Flow & Safety Net](#cash-flow--safety-net)
- [Investing Essentials](#investing-essentials)
- [Portfolio Construction & Tax Awareness](#portfolio-construction--tax-awareness)
- [Project Application Map](#project-application-map)
- [Registered Accounts (Canada Primer)](#registered-accounts-canada-primer)
- [Retirement Planning & Decumulation](#retirement-planning--decumulation)
- [Insurance & Risk Management](#insurance--risk-management)
- [Estate & Legacy](#estate--legacy)
- [Practice Operations (CRM, cadence, templates)](#practice-operations-crm-cadence-templates)
- [Skill-Building Roadmap](#skill-building-roadmap)
- [Glossary](#glossary)
- [Appendix: Re-usable Templates](#appendix-re-usable-templates)
- [Changelog](#changelog)

---

## Core Framework & Process

### Client-First Mindset
- Fiduciary spirit: **client interests first**, fully informed, transparent, documented.
- Behavioral coaching > product selection. You are a **process manager**.

### The 7-D Process (overview)
1. **Discover** (goals, values, constraints)
2. **Data** (statements, budgets, tax returns)
3. **Diagnose** (gaps, risks, priorities)
4. **Design** (plan, IPS, portfolio)
5. **Deliver** (explain, educate, obtain consent)
6. **Do** (implement, automate, rebalance)
7. **Debrief** (reviews, reporting, iterate)

### Planning Pyramid
- Base: **Cash flow, emergency fund, insurance, debts**
- Middle: **Tax-advantaged savings & diversified portfolio**
- Top: **Goals (retirement, education, real estate), estate, advanced tax**

<!-- TODO: Add your own diagram link or ASCII sketch -->

---

## Compliance & Ethics (Canada)

> [!TIP]
> Keep this section general. Put **specific rules/limits** in a separate annually updated page and link to it from here.

### Core Duties
- **KYC** (Know Your Client): collect/refresh profile, objectives, risk tolerance/capacity, constraints.
- **KYP** (Know Your Product): features, risks, costs, suitability vs. alternatives.
- **Suitability & Client-Focused Reforms**: document rationale for all recommendations.
- **Conflicts & Disclosure**: identify, control, and **document** mitigation.
- **Privacy**: store and share data per policy; obtain consents; secure transmission.

### Documentation You Always Keep
- Discovery notes, signed IPS, proposals, cost/fee disclosures, trade rationales, review agendas & minutes.

### Red-Flag Triggers (hold & escalate)
- Sudden risk-seeking trades inconsistent with IPS, vulnerable client indicators, incomplete KYC, or suspected fraud.

---

## Client Discovery & IPS

### Discovery (what to uncover)
- **Goals** (timelines, $ targets, must-haves vs nice-to-haves)
- **Cash flows** (income stability, savings rate), **balance sheet** (assets, debts)
- **Risk**: tolerance (psychological), **capacity** (financial), **need** (required return)
- **Constraints**: time horizon, liquidity needs, tax, legal, unique preferences (ESG, screens)

### Build the IPS (Investment Policy Statement)
- Purpose & scope  
- Roles & responsibilities  
- Risk profile (tolerance/capacity)  
- Strategic asset allocation & ranges  
- Selection criteria (ETFs, funds, individual securities)  
- Rebalancing policy (thresholds / bands)  
- Monitoring, reporting, and review cadence

<!-- TODO: Paste signed IPS template into Appendix and link it here -->

---

## Cash Flow & Safety Net

### Core Objectives
- Positive **savings rate** aligned to goals.
- **Emergency fund** sized to job stability and dependents.
- **Debt plan**: prioritize high-cost debt; match amortization to asset life.
- Automation: pay-yourself-first, bill syncing to pay cycles.

### Practical Checks
- [ ] Spending categorized (fixed, variable, discretionary)  
- [ ] Annual big-ticket calendar (taxes, insurance, travel)  
- [ ] Debt inventory with rates/terms and pay-down plan

---

## Investing Essentials

### Asset Classes & Roles
- **Equities** (growth), **Fixed income** (stability/income), **Cash** (liquidity), **Alts** (diversifiers; complexity).

### Core Principles
- Diversification, low costs, taxes matter, time in market > timing, behavior discipline.

### Key Metrics (formulas you’ll re-use)
- **CAGR**: \[(Ending/Beginning)^(1/Years) − 1\]  
- **Volatility**: std. dev. of periodic returns  
- **Sharpe (ex-post)**: (Return − Risk-free) / Volatility  
- **Max Drawdown**: min(rolling peak-to-trough)

<!-- TODO: Link to your spreadsheet or Python notebook implementing these -->

---

## Portfolio Construction & Tax Awareness

### From Plan to Portfolio
- **Strategic allocation** (long-term), **Tactical** (rare, bounded), **Core-satellite** (broad core, focused satellites).
- **Rebalancing**: calendar (e.g., semi-annual) plus **bands** (e.g., ±20% of asset-class weight or ±2–5 pts). Document it.

### Tax Location (Canada-focused, keep numbers elsewhere)
- **Registered** (RRSP/LIRA/RRIF, TFSA, FHSA, RESP, RDSP) vs **taxable** accounts.
- General idea: place the most **tax-inefficient** income where tax is deferred/ sheltered **when appropriate** given client constraints.

### Withdrawal Coordination (high level)
- Sequence across registered/taxable to manage brackets, benefits, and longevity risk—**document rationale**.

---

## Project Application Map

Use this section to turn theory into publishable work products on your site.

### 1) Portfolio Rebalancing Workflow
- **Project link:** [Portfolio Rebalancer Tool](/projects/portfolio-rebalancer/)
- **Use case:** convert current holdings and policy weights into advisor-ready trade instructions.
- **Client deliverables you can attach:**
  - Drift snapshot (current vs target)
  - Proposed buy/sell list
  - Rebalancing rationale memo (policy-based, non-emotional)

### 2) CPI Monitoring & Inflation Commentary
- **Project link:** [CPI Webscraper Project](/projects/cpi-webscraper/)
- **Use case:** automate CPI updates, then incorporate inflation context into planning assumptions.
- **Client deliverables you can attach:**
  - Monthly inflation briefing (1-page summary)
  - Inflation sensitivity note for retirement cash flow
  - Assumption-change log (old vs new planning inputs)

### 3) Spreadsheet Operations & Data Hygiene
- **Resource link:** [Scripts & Automation](/scripts/)
- **Use case:** reduce manual spreadsheet cleanup and reporting errors.
- **Client deliverables you can attach:**
  - Data prep checklist
  - QA signoff notes before portfolio review meetings
  - Standard operating procedures for recurring reports

### Suggested cadence for applying these projects
- **Monthly:** CPI refresh + commentary
- **Quarterly/Semi-Annual:** portfolio drift check + rebalance recommendation
- **Annually:** IPS refresh, assumptions review, compliance note archive

---

## Registered Accounts (Canada Primer)

> Keep detailed **limits/phase-outs** on a separate “202X Limits” page and update annually.

### High-Level Roles
- **RRSP**: tax-deferred growth; contributions deductible; withdrawals taxable (future tax planning needed).
- **TFSA**: tax-free growth/withdrawals; contribution room accumulates; flexible for goals.
- **FHSA**: first-home savings with deduction + tax-free qualified withdrawal (time-boxed account).
- **RESP**: education savings with federal grants; plan for EAP withdrawals.
- **RDSP**: disability savings with grants/bonds; specific eligibility rules.

<!-- TODO: Add links to your annually updated limits page -->

---

## Retirement Planning & Decumulation

### Key Concepts
- **Target income** (needs/wants/gifts), **longevity risk**, **sequence risk**.
- **Pension/benefits** (CPP/OAS), employer pensions, personal accounts (RRSP/TFSA/non-reg).
- **Withdrawal rulesets**: fixed %, guardrails, floor-and-upside, annuity blends.

### Stress-Testing
- Historical, Monte Carlo, and **what-if** (bad first 5 years, inflation spikes). Document results in review pack.

---

## Insurance & Risk Management

### Protect the Plan
- **Life**, **Disability**, **Critical Illness**, **Liability/Umbrella**, **Property/Auto**, **Health**.
- Coverage sizing ideas: income replacement, debt payoff, education funding, legacy wishes.

### Practical Steps
- [ ] Policy inventory with owners/beneficiaries  
- [ ] Gap analysis vs needs  
- [ ] Annual review on renewal

---

## Estate & Legacy

### Essentials
- **Will**, **Powers of Attorney** (property & personal care), **beneficiary designations**, guardianship, digital assets plan.
- Coordinate with legal/tax pros; align account titling and beneficiaries with the plan.

---

## Practice Operations (CRM, cadence, templates)

### Cadence
- **Initial** (discovery → plan → implementation).  
- **Review**: at least annually; also life-event or drift/rebalance triggers.

### Hygiene
- Standard file names (YYYY-MM-DD_topic), searchable notes, email templates, task checklists.

### Meeting Pack (what to include)
- Performance & progress to goals, risk review, cash-flow check, tax actions, action items with owners/dates.

---

## Skill-Building Roadmap

### Technical (weekly reps)
- **Spreadsheets** (returns, drawdowns, glidepaths), **Python/R** (backtests, reports), **Power BI** (dashboards).
- **Tax literacy** (read CRA guides annually), **product due diligence** (prospectus/ETF factsheets).

### Communication
- Plain-language explanations, one-page summaries, visual aids, **behavioral coaching** scripts.

### Drills (check off as you go)
- [ ] Write a 1-page IPS for a sample client  
- [ ] Build a rebalancing memo using your template  
- [ ] Run a 30-year retirement stress test and summarize in 150 words  
- [ ] Explain TFSA vs RRSP trade-offs in plain English

---

## Glossary

### Core Terms
- **Risk capacity**: ability to absorb losses without derailing goals.  
- **Risk tolerance**: comfort with volatility/drawdowns.  
- **Sequence risk**: order of returns affecting outcomes during withdrawals.  
<!-- TODO: Add 20–30 more entries over time -->

---

## Appendix: Re-usable Templates

### IPS Skeleton (copy/paste into client file)

**Client name:**  
**Date:**  
**Advisor:**  

**1. Objectives**
- Primary goals:
- Time horizon:
- Required return range:

**2. Risk Profile**
- Risk tolerance:
- Risk capacity:
- Liquidity constraints:

**3. Strategic Allocation**
- Equity: ___%
- Fixed income: ___%
- Cash: ___%
- Alternatives: ___%

**4. Rebalancing Policy**
- Frequency:
- Drift threshold:
- Exceptions/escalation rules:

**5. Monitoring & Review**
- Reporting cadence:
- Trigger events:
- Documentation standard:

### Rebalancing Memo Template

**Purpose:** Document why the recommended trades are suitable and policy-aligned.

1. **Current vs target allocation**
2. **Observed drift**
3. **Recommended trades (buy/sell amounts)**
4. **Tax, liquidity, and account-location considerations**
5. **Client communication summary**
6. **Approval and implementation date**

### CPI Commentary Template (Monthly)

**Month/Date:**  
**Headline CPI direction:**  
**Core inflation trend (high level):**  
**Portfolio/planning implications:**  
**Action items:**  

---

## Changelog

- **2026-03-13**
  - Added project-linked application map tying this note to live tools/pages.
  - Added reusable advisor templates (IPS, rebalance memo, CPI commentary).
  - Updated cadence guidance and implementation examples.
