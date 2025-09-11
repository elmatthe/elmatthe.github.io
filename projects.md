---
layout: page
title: Projects
---

Case studies and client-style writeups.

<ul>
{%- assign pages = site.pages | where_exp: "p", "p.path contains 'projects/'" -%}
{%- for p in pages %}
  {%- unless p.name == '_template.md' -%}
  <li><a href="{{ p.url | relative_url }}">{{ p.title }}</a>{% if p.summary %} — {{ p.summary }}{% endif %}</li>
  {%- endunless -%}
{%- endfor -%}
</ul>
