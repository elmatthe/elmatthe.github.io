---
layout: page
title: Home
---


## Latest Notes
{% assign note_pages = site.pages | where_exp:"p","p.url contains '/notes/'" | sort:"title" %}
{% for p in note_pages %}
{% unless p.url == "/notes/" %}
- [{{ p.title | escape }}]({{ p.url }})
{% endunless %}
{% endfor %}

## Featured Projects
- [1m Plan](/projects/1m-plan/)

## Scripts
- [Portfolio Rebalance Tool](/scripts/portfolio-rebalance-tool/)