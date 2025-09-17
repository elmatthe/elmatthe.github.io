---
layout: page
title: Home
---

## Latest Notes
<ul>
{% assign all = site.pages | sort: "last_updated" | reverse %}
{% for p in all %}
  {% if p.path contains 'notes/' and p.name != 'index.md' %}
    <li><a href="{{ p.url | relative_url }}">{{ p.title | escape }}</a></li>
  {% endif %}
{% endfor %}
</ul>

## Featured Projects
<ul>
{% assign projects = site.pages | sort: "title" %}
{% for p in projects %}
  {% if p.path contains 'projects/' and p.name != 'index.md' %}
    <li><a href="{{ p.url | relative_url }}">{{ p.title | escape }}</a></li>
  {% endif %}
{% endfor %}
</ul>

## Scripts
<ul>
{% assign tools = site.pages | sort: "title" %}
{% for p in tools %}
  {% if p.path contains 'scripts/' and p.name != 'index.md' %}
    <li><a href="{{ p.url | relative_url }}">{{ p.title | escape }}</a></li>
  {% endif %}
{% endfor %}
</ul>