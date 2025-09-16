## Latest Notes
{% assign note_pages = site.pages 
   | where_exp: "p", "p.url contains '/notes/' and p.url != '/notes/'" 
   | sort: "title" %}
<ul>
  {% for p in note_pages limit:5 %}
    <li><a href="{{ p.url }}">{{ p.title }}</a></li>
  {% endfor %}
</ul>

## Featured Projects
- [1m Plan](/projects/1m-plan/)

## Scripts
- [Portfolio Rebalance Tool](/scripts/portfolio-rebalance-tool/)
