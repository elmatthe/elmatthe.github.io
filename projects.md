---
title: Projects
layout: page
permalink: /projects/
---

# Projects

Case studies and client-style writeups.

<ul>
{% assign projects = site.pages | sort: "title" %}
{% for p in projects %}
  {% if p.path contains 'projects/' and p.name != 'index.md' %}
    <li><a href="{{ p.url | relative_url }}">{{ p.title | escape }}</a></li>
  {% endif %}
{% endfor %}
</ul>
