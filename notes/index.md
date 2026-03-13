---
title: Notes
layout: page
permalink: /notes/
nav_order: 9
has_children: true
---

# Notes

<ul>
{% assign notes = site.pages | sort: "title" %}
{% for p in notes %}
  {% if p.path contains 'notes/' and p.name != 'index.md' %}
    <li><a href="{{ p.url | relative_url }}">{{ p.title | escape }}</a></li>
  {% endif %}
{% endfor %}
</ul>
