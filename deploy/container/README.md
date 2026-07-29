# Opt-in Dashboard container entrypoint

`moryn-dashboard-entrypoint.mjs` keeps the Moryn Dashboard available while one
foreground container command is running. Nothing invokes this entrypoint
automatically: an image or `docker run` command must select it explicitly.

The supplied foreground command owns the container lifecycle. Its exit status
becomes the entrypoint's exit status, even if the Dashboard has crashed. While
that command remains alive, an unexpected Dashboard exit is restarted with
exponential backoff capped at 10 seconds by default. A Dashboard that stayed
alive for 30 seconds resets the backoff by default.

On `SIGTERM` or `SIGINT`, the entrypoint forwards the same signal to the main
command's process group and the Dashboard process group. It gives the Dashboard
five seconds to stop, then uses `SIGKILL` as a bounded fallback. It does not
force an exit code on the main command; the command's eventual exit still
decides the entrypoint result.

## Use

The image needs Node.js 20 or newer and a working Moryn CLI. Copy the entrypoint
into the image, then make it the explicit entrypoint while retaining the
application command as `CMD`:

```dockerfile
COPY deploy/container/moryn-dashboard-entrypoint.mjs /usr/local/lib/moryn/
ENTRYPOINT ["node", "/usr/local/lib/moryn/moryn-dashboard-entrypoint.mjs"]
CMD ["your-main-command", "--foreground"]
```

The same contract can be exercised without changing an image:

```bash
node deploy/container/moryn-dashboard-entrypoint.mjs your-main-command --foreground
```

The entrypoint runs this Dashboard command by default:

```bash
moryn dashboard --serve --no-open --host 127.0.0.1 --port 8765
```

Set only the values the deployment needs:

| Environment variable | Default | Effect |
| --- | --- | --- |
| `MORYN_DASHBOARD_EXECUTABLE` | `moryn` | Moryn executable name or absolute path |
| `MORYN_DASHBOARD_STORE` | Moryn default | Adds global `--store <path>` |
| `MORYN_DASHBOARD_HOST` | `127.0.0.1` | Dashboard bind host |
| `MORYN_DASHBOARD_PORT` | `8765` | Dashboard bind port |
| `MORYN_DASHBOARD_PROJECT` | unset | Adds `--project <path>` |
| `MORYN_DASHBOARD_PROJECT_ID` | unset | Adds `--project-id <id>`; mutually exclusive with `MORYN_DASHBOARD_PROJECT` |
| `MORYN_DASHBOARD_READINESS_HOST` | unset | Adds `--readiness-host <host>` |
| `MORYN_DASHBOARD_SYNC_REMOTE` | unset | Adds `--sync-remote <remote>` |
| `MORYN_DASHBOARD_RESTART_BASE_MS` | `250` | First restart delay |
| `MORYN_DASHBOARD_RESTART_MAX_MS` | `10000` | Maximum restart delay |
| `MORYN_DASHBOARD_RESTART_STABLE_MS` | `30000` | Healthy runtime that resets backoff |
| `MORYN_DASHBOARD_STOP_GRACE_MS` | `5000` | Grace period before forced Dashboard stop |

For a published Docker port, explicitly set `MORYN_DASHBOARD_HOST=0.0.0.0` and
apply the network and access controls described in the Dashboard guide. The
local-only default avoids accidentally exposing memory content.

## Scope boundary

This entrypoint supervises only the Moryn Dashboard and the supplied main
command. It does not start or restart a reverse proxy, `cloudflared`, the VS
Code `forward-internal` process, or any other tunnel connector. It does not
read, store, mint, rotate, or log access tokens. Those components and their
credentials remain the external deployment's responsibility.

The entrypoint also does not configure or replace a Docker/Compose restart
policy. Container-level recovery remains an operator decision; Dashboard
process recovery while the main command is alive is the only restart behavior
implemented here.
