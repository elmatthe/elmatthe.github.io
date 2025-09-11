---
layout: page
title: Notes
---

Below are all notes in `/notes`.

<ul>
{%- assign pages = site.pages | where_exp: "p", "p.path contains 'notes/'" -%}
{%- for p in pages %}
  {%- unless p.name == '_template.md' -%}
  <li><a href="{{ p.url | relative_url }}">{{ p.title }}</a>{% if p.summary %} — {{ p.summary }}{% endif %}</li>
  {%- endunless -%}
{%- endfor -%}
</ul>
