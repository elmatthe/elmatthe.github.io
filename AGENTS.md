# AGENTS.md

## Cursor Cloud specific instructions

This is a Jekyll-based GitHub Pages static site using the `minima` theme. There are no backend services, databases, or Docker containers.

### Running the site locally

```
bundle exec jekyll serve --host 0.0.0.0 --port 4000
```

The site will be available at `http://127.0.0.1:4000/`. Jekyll watches for file changes and auto-regenerates. See `README.md` for the full list of site pages.

### Key notes

- The `Gemfile` uses the `github-pages` gem, which pins Jekyll and plugin versions to match the GitHub Pages build environment.
- `sudo bundle install` is required because system Ruby gem paths need elevated permissions. The update script handles this automatically.
- There are no automated tests, linters, or CI pipelines configured in this repository.
- The `_config.yml` sets `theme: minima` and configures header navigation pages.
- Three standalone Python desktop GUI scripts live under `projects/` (Monte Carlo Simulator, Portfolio Rebalancer, CPI Downloader). They are not part of the Jekyll build and require Python 3 + tkinter to run independently.
