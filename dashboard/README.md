# Local call history dashboard

Run `npm run dashboard:open` and visit **http://127.0.0.1:8790**. On macOS you can also double-click `Open Call Dashboard.command`. `npm run dashboard` runs in the foreground. The service URL comes from `wrangler.jsonc`; owner/Telnyx credentials stay in `.dev.vars` on the local server.

The dashboard shows all accessible calls, outcomes, estimated usage, searchable transcripts and recordings available through your Telnyx account or local MP3/WAV imports. Click Refresh after calls. It cannot synthesize missing audio from old transcripts.

The UI binds only 127.0.0.1, validates browser origin for writes, and never exposes API keys to the page. Do not put it behind a public tunnel or change its bind address without adding authentication. Another program running as your local user can access local files and loopback services; this is not an OS-user isolation boundary.

Storage defaults:

- macOS: `~/Library/Application Support/Muse Calling Assistant/dashboard/`
- Linux: `$XDG_DATA_HOME/Muse Calling Assistant/dashboard/` or `~/.local/share/Muse Calling Assistant/dashboard/`
- Windows: `%LOCALAPPDATA%/Muse Calling Assistant/dashboard/` (development primarily tested on macOS; WSL recommended)

`CALLING_DASHBOARD_DATA_DIR` can override storage; keep it outside a shared/synced checkout. Use `DASHBOARD_PORT` to select another port. History and imported/cached audio are private files. This public edition uses a separate storage directory from the source owner's original dashboard.

Sync is manual after the first empty launch, cached, deduplicated and paced. It bounds history to 100 call entries, up to 200 detail reads and 20 carrier-recording pages per refresh. Downloaded/imported audio is limited to 100 MB per file. Playback supports byte ranges; original recordings are not retranscribed. New recording depends on the call brief, carrier capture and saved event; actual provider billing remains separate from displayed estimates.

Local transcript fragments expire after 30 days, while summaries and local recordings have separate retention. Deleting hosted content does not automatically purge all local audio or carrier copies. Manage those deliberately in their respective stores.
