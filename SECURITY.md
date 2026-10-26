# Security

## Your keys and data

- Your Comfy API key lives only in `app/.env`, which is gitignored. The server
  sends it only to Comfy with your own jobs. It is never sent to the browser,
  written to logs or saved in exported workflows.
- Everything you upload or generate stays in `app/data/` and
  `app/.private-data/` on your machine. Both are gitignored.
- The server listens on every network interface by default, so devices on
  your network (your phone, for example) can open it. Set
  `BACKLOT_HOST=127.0.0.1` to keep it on your own machine.
- If you expose it further (a tunnel, a public host), set
  `BACKLOT_RENDER_CAP` so visitors cannot spend your credits without limit,
  and remember that anyone with the link can use your key through the app.

## Reporting a problem

Please report security issues privately through GitHub's
**Security › Report a vulnerability** on this repository rather than in a
public issue.
