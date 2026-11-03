# Reproduction scripts for the 2026-11-03 audit

These scripts read the site's own modules, use mocked providers, and never modify the repository. They were run at revision `ada2ceb`. Pass the repository path as the first argument. Screenshots go to `$OUT_DIR`, or to the system temp directory if it is not set.

| Script | Reproduces | Command |
|---|---|---|
| `classify_av_notices.mjs` | Report §4.2, AV-01: how the site classifies Alpha Vantage's nine verbatim notices (Appendix A.3). | `node classify_av_notices.mjs /path/to/repo` |
| `classify.mjs` | Report §4.1–4.2: requests per ticker, burst vs daily notices, the persisted lock and the counter, using a mocked provider. No network. | `node classify.mjs /path/to/repo` |
| `incident.js` | Report §4.3 and SS-01…SS-06: the owner's Rebalancer run in Chromium (sample edited to 10 rows, key saved, live run) under three provider behaviours. | see below |
| `layout.js` | Report SS-08…SS-10: horizontal overflow of the Rebalancer's tables at 9 widths. | see below |

For the two browser scripts, build and serve the site locally first. Both scripts use the repository's Playwright harness (`_tools/tests/browser/harness.js`), which mocks the Bank of Canada, the ECB and Alpha Vantage.

```bash
bundle exec jekyll build -d /tmp/site && (python3 -m http.server 4000 --bind 127.0.0.1 --directory /tmp/site &)
```

```bash
SITE_URL=http://127.0.0.1:4000 node incident.js /path/to/repo
```

```bash
SITE_URL=http://127.0.0.1:4000 node layout.js /path/to/repo
```

No API key is used or needed. The test key `TESTKEY12345` exists only inside the mocks.
