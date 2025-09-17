---
title: Scripts
layout: page
permalink: /scripts/
---

# Scripts

Utility code and tools.

<ul>
{% assign tools = site.pages | sort: "title" %}
{% for p in tools %}
  {% if p.path contains 'scripts/' and p.name != 'index.md' %}
    <li><a href="{{ p.url | relative_url }}">{{ p.title | escape }}</a></li>
  {% endif %}
{% endfor %}
</ul>
