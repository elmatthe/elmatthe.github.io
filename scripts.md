---
layout: page
title: Scripts
---

Utility code and tools.

<ul>
{%- assign pages = site.pages | where_exp: "p", "p.path contains 'scripts/'" -%}
{%- for p in pages %}
  {%- unless p.name == '_template.md' -%}
  <li><a href="{{ p.url | relative_url }}">{{ p.title }}</a>{% if p.summary %} — {{ p.summary }}{% endif %}</li>
  {%- endunless -%}
{%- endfor -%}
</ul>
