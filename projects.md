---
title: Projects
layout: page
permalink: /Projects/
---

# Projects

Applied finance and advisor workflow projects designed for real-world planning conversations.

<section class="callout">
  <p><strong>How to read this section:</strong> each project includes objective, method, and practical implementation notes to reflect advisory-quality communication.</p>
</section>

## CPI Automation Downloads
<section class="tool-card">
  <p><strong>Need a spreadsheet starter pack?</strong> Download the CPI portfolio/rebalancing templates directly below.</p>
  <div class="btn-row">
    <a class="btn" href="{{ '/assets/downloads/cpi_portfolio_rebalance_template.xlsx' | relative_url }}" download>Download .xlsx</a>
    <a class="btn btn-secondary" href="{{ '/assets/downloads/cpi_portfolio_rebalance_template.xlsm' | relative_url }}" download>Download .xlsm</a>
    <a class="btn btn-secondary" href="{{ '/projects/cpi-dashboard-automation/' | relative_url }}">Open CPI Project Details</a>
  </div>
</section>

<ul class="project-list">
{% assign projects = site.pages | sort: "title" %}
{% for p in projects %}
  {% if p.path contains 'projects/' and p.name != 'index.md' %}
    <li>
      <a href="{{ p.url | relative_url }}">{{ p.title | escape }}</a>
      {% if p.summary %}<div class="muted">{{ p.summary }}</div>{% endif %}
    </li>
  {% endif %}
{% endfor %}
</ul>
