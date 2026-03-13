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
  <p><strong>Need the CPI workbook starter files?</strong> Download the CPI dashboard templates directly below.</p>
  <div class="btn-row">
    <a class="btn" href="{{ '/projects/CPI_Automation/CPI.xlsx' | relative_url }}" download>Download CPI .xlsx</a>
    <a class="btn btn-secondary" href="{{ '/projects/CPI_Automation/CPI.xlsm' | relative_url }}" download>Download CPI .xlsm</a>
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
