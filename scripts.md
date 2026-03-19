---
layout: page
title: Scripts
permalink: /scripts/
---

{% assign project_files = site.static_files | sort: "path" %}
{% assign py_count = 0 %}
{% assign py_archive_count = 0 %}
{% assign vba_count = 0 %}

{% for file in project_files %}
  {% if file.path contains '/projects/' and file.path contains '.py' %}
    {% if file.path contains 'Version Archive' %}
      {% assign py_archive_count = py_archive_count | plus: 1 %}
    {% else %}
      {% assign py_count = py_count | plus: 1 %}
    {% endif %}
  {% endif %}
  {% if file.path contains '/projects/' and file.path contains '.bas' %}
    {% assign vba_count = vba_count | plus: 1 %}
  {% endif %}
{% endfor %}

<section class="hero-panel">
  <p class="eyebrow">Automation Library</p>
  <h1>Scripts &amp; Automation Catalog</h1>
  <p class="lede">Download-ready script catalog for the portfolio, including production Python tools, historical script versions, and VBA utility modules.</p>
</section>

<div class="card-grid">
  <section class="card">
    <h3>Python Tools</h3>
    <p class="muted">{{ py_count }} active scripts</p>
  </section>
  <section class="card">
    <h3>Python Archive</h3>
    <p class="muted">{{ py_archive_count }} versioned scripts</p>
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
<ul class="script-list">
{% for file in project_files %}
  {% if file.path contains '/projects/' and file.path contains '.py' %}
    {% unless file.path contains 'Version Archive' %}
      <li>
        <a href="{{ file.path | replace: ' ', '%20' | relative_url }}" download>{{ file.name }}</a>
        <span class="script-meta">{{ file.path }}</span>
      </li>
    {% endunless %}
  {% endif %}
{% endfor %}
</ul>

## Python Script Version Archive
<ul class="script-list">
{% for file in project_files %}
  {% if file.path contains '/projects/' and file.path contains '.py' and file.path contains 'Version Archive' %}
    <li>
      <a href="{{ file.path | replace: ' ', '%20' | relative_url }}" download>{{ file.name }}</a>
      <span class="script-meta">{{ file.path }}</span>
    </li>
  {% endif %}
{% endfor %}
</ul>

## VBA Scripts (Excel Utilities)
<ul class="script-list">
{% for file in project_files %}
  {% if file.path contains '/projects/' and file.path contains '.bas' %}
    <li>
      <a href="{{ file.path | replace: ' ', '%20' | relative_url }}" download>{{ file.name }}</a>
      <span class="script-meta">{{ file.path }}</span>
    </li>
  {% endif %}
{% endfor %}
</ul>

## Notes
<ul class="link-list">
  <li>Scripts are provided as implementation examples and can be adapted into client reporting or internal operational workflows.</li>
  <li>Live website content updates after branch changes are merged and deployed to the publishing branch.</li>
</ul>
