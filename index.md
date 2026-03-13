---
layout: page
title: Home
---

<section class="hero-panel">
  <p class="eyebrow">Wealth Management Portfolio</p>
  <h1>Financial planning, portfolio analytics, and advisor-ready tools.</h1>
  <p class="lede">
    I build practical, client-focused finance resources that support better planning decisions,
    cleaner operations, and disciplined portfolio management.
  </p>
  <div class="hero-actions">
    <a class="button button-primary" href="{{ '/Projects/' | relative_url }}">View Projects</a>
    <a class="button" href="{{ '/about/' | relative_url }}">About Me</a>
  </div>
</section>

## Advisory Focus
<div class="card-grid">
  <article class="card">
    <h3>Portfolio Construction</h3>
    <p>Allocation design, drift controls, and policy-based rebalancing workflows.</p>
  </article>
  <article class="card">
    <h3>Process & Compliance</h3>
    <p>Repeatable templates and documentation habits that support client-first advice.</p>
  </article>
  <article class="card">
    <h3>Automation</h3>
    <p>Python and VBA utilities to reduce manual work and improve reporting reliability.</p>
  </article>
</div>

## Latest Notes
<ul class="link-list">
{% assign all = site.pages | sort: "last_updated" | reverse %}
{% assign note_count = 0 %}
{% for p in all %}
  {% if p.path contains 'notes/' and p.name != 'index.md' %}
    {% assign note_count = note_count | plus: 1 %}
    <li><a href="{{ p.url | relative_url }}">{{ p.title | escape }}</a></li>
  {% endif %}
{% endfor %}
{% if note_count == 0 %}
  <li>No notes published yet.</li>
{% endif %}
</ul>

## Featured Projects
<ul class="link-list">
  <li><a href="{{ '/projects/cpi-dashboard-automation/' | relative_url }}">CPI Dashboard Automation</a></li>
  <li><a href="{{ '/projects/portfolio-rebalancer/' | relative_url }}">Portfolio Rebalancer Tool</a></li>
</ul>

## Scripts
<ul class="link-list">
  <li><a href="{{ '/scripts/' | relative_url }}">View Script Catalog</a></li>
</ul>