---
layout: page
title: Scripts
permalink: /scripts/
---

{% assign project_files = site.static_files | sort: "path" %}
{% assign py_count = 0 %}
{% assign vba_count = 0 %}

{% for file in project_files %}
  {% if file.path contains '/projects/' and file.path contains '.py' %}
    {% assign py_count = py_count | plus: 1 %}
  {% endif %}
  {% if file.path contains '/projects/' and file.path contains '.bas' %}
    {% assign vba_count = vba_count | plus: 1 %}
  {% endif %}
{% endfor %}

<section class="hero-panel">
  <p class="eyebrow">Automation Library</p>
  <h1>Scripts &amp; Automation Catalog</h1>
  <p class="lede">Download-ready script catalog for the portfolio, including production Python tools and VBA utility modules.</p>
</section>

<div class="card-grid">
  <section class="card">
    <h3>Python Tools</h3>
    <p class="muted">{{ py_count }} active scripts</p>
  </section>
  <section class="card">
    <h3>VBA Utilities</h3>
    <p class="muted">{{ vba_count }} `.bas` modules</p>
  </section>
</div>

<section class="callout">
  <p><strong>Catalog behavior:</strong> this page auto-reads script files from the <code>/projects/</code> directory, so newly added Python/VBA files appear here without manual list maintenance.</p>
</section>

## Python Scripts (Current Tools)
<ul class="link-list">
{% for file in project_files %}
  {% if file.path contains '/projects/' and file.path contains '.py' %}
    <li><a href="{{ file.path | replace: ' ', '%20' | relative_url }}" download>{{ file.name }}</a></li>
  {% endif %}
{% endfor %}
</ul>

## VBA Scripts (Excel Utilities)
<ul class="link-list">
{% for file in project_files %}
  {% if file.path contains '/projects/' and file.path contains '.bas' %}
    <li><a href="{{ file.path | replace: ' ', '%20' | relative_url }}" download>{{ file.name }}</a></li>
  {% endif %}
{% endfor %}
</ul>

### VBA Macro Documentation
<ul class="link-list">
  <li><a href="{{ '/scripts/vba-scripts-guide/' | relative_url }}">VBA Scripts Guide (rendered page)</a> - <a href="{{ '/projects/VBA_Macros_and_Functions/VBA_Scripts_Guide.md' | relative_url }}" download>Download .md</a></li>
  <li><a href="{{ '/scripts/print-from-excel-to-fit-page-guide/' | relative_url }}">Print from Excel to Fit Page Guide (rendered page)</a> - <a href="{{ '/projects/VBA_Macros_and_Functions/Print_from_excel_to_fit_page_Guide.md' | relative_url }}" download>Download .md</a></li>
</ul>

## Notes
<ul class="link-list">
  <li>Scripts are provided as implementation examples and can be adapted into client reporting or internal operational workflows.</li>
  <li>Live website content updates after branch changes are merged and deployed to the publishing branch.</li>
</ul>
