---
layout: page
title: Home
---


## Latest Notes
{% assign note_pages = site.pages | where_exp:"p","p.url contains '/notes/'" %}
<ul>
  {% for p in note_pages %}
    {% unless p.url == "/notes/" %}
      <li><a href="{{ p.url }}">{{ p.title }}</a></li>
    {% endunless %}
  {% endfor %}
</ul>

## Featured Projects
- [1m Plan](/projects/1m-plan/)

## Scripts
- [Portfolio Rebalance Tool](/scripts/portfolio-rebalance-tool/)
