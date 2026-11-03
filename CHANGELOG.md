# Changelog

This project is in development. 0.x releases may include breaking changes to features, settings or the stored record format. Export your records to CSV before updating.

## 0.3.2 — 2026-11-04

- Requires Obsidian 1.7.2 or later. 0.3.1 claimed 1.5.0, but it already relied on an API added in 1.7.2.
- Passes Obsidian's plugin lint rules (`eslint-plugin-obsidianmd`) with no errors, ahead of submission to the community directory. Run `npm run lint`.
- Tightened types in the chart statistics and settings loading, and removed unneeded type assertions.
- UI text follows Obsidian's sentence-case style.

## 0.3.1 — 2026-11-04

First public release.

- **Sensitive encryption changes need your passphrase.** Creating a recovery key, changing the passphrase or turning encryption off asks for the current passphrase (or recovery key), so someone at an unlocked, unattended computer can't make their own recovery key.
- **Warning if encryption silently goes away.** If `records.json` turns up unencrypted or missing while encryption was on (e.g. replaced by a sync conflict), you're warned instead of new data quietly being saved as plain text.
- **Lock is reliable.** Locking writes the encrypted file before forgetting the key, and only says "locked" once it really is.
- **Damaged data is handled.** Settings, categories and records are checked when loaded. Colours must be plain hex values, so an edited or synced file can't inject CSS that loads a remote resource. If `records.json` can't be read, or some entries are damaged, a backup copy is kept and you're told where it is, instead of the plugin failing to start. Unknown dashboard chart types are skipped.
- A file saved by a newer version of the plugin says so, instead of reporting a wrong passphrase.
- Email drops and activity (for auto-lock) are also caught in pop-out windows.
- Files over 50 MB are rejected before they're read.
- Releases are built in GitHub Actions with build provenance attestations. MIT license; bundled third-party licenses are in `THIRD_PARTY_LICENSES.md`.

## 0.3.0 — 2026-11-03

- **Tasks rethought: the category is the task.** Its emails, including those in its child categories, are the task's activity. Status follows the newest email containing a status phrase: Done ("resolved", "completed", "closed"), Waiting ("waiting on", "pending", "on hold") or Reopen ("not resolved", "still not working"). The longest phrase wins, and quoted reply history is ignored. Phrases are editable per task.
- Milestones: ordered phrases per task (e.g. approved → ordered → delivered) shown as progress with the date each was reached.
- New **Tasks** card on the dashboard: status and why, a manual status override (holds until a newer email changes it), progress, last activity, days open and due date. Click a task for its email timeline.
- The email table's Status and Due columns are replaced by **Signal**, showing what each email contributed to its tasks. Search covers status phrases.
- Task categories show a clipboard icon in the category list, settings, chips and the category filter.
- Per-email statuses from 0.2.x are dropped; status now belongs to the task.
- **Recovery key for encryption.** Turning encryption on shows a one-time recovery key. "Forgot passphrase?" on the unlock screen unlocks with it and sets a new passphrase. Changing the passphrase keeps the recovery key valid, and you can create a new key in settings. Existing encrypted files upgrade on unlock and prompt you to create a key.
- CSV exports always warn that the file is not encrypted.
- "Sub-categories" are now called "Child categories".
- HTML emails keep their line breaks when converted to text, so reply headers are recognised.

## 0.2.1 — 2026-11-03

- Fixed: saving a category while the settings tab had been opened froze Obsidian. The change was saved, but the settings tab kept redrawing itself in an endless loop.
- The category editor has a **Relationships** section with two lists, **Parent categories** and **Sub-categories**. Tick existing categories in either list, or type a name to create a new one. Choices that would put a category inside itself are greyed out.

## 0.2.0 — 2026-11-03

- Categories can have several parents (e.g. Unity under both Gaming and Software), and an email gets every category it matches. A parent with its own filter must also match for an email to count through it; a parent with no filter is a group. Priority order is gone.
- Existing data migrates automatically: categories move from `data.json` into `records.json`, and each email keeps its category. Emails that also match another category pick it up the next time filters run.
- Manage categories from the dashboard (hover a category for edit, add and delete; right-click for "Remove from parent") and from settings, which now has a delete button on each row.
- Place an email in categories by hand from the table, or send it back to automatic sorting.
- Dashboard charts are configurable panels: stacked or grouped bars, lines, ranked bars, donut, category × period and day × hour heatmaps, calendar, top senders, task status. Add, remove, resize and reorder them.
- Optional encryption of `records.json`, including categories and filters (AES-256-GCM, key from your passphrase via PBKDF2-SHA-256 with 600k rounds). Unlock once per session; idle auto-lock; Lock and Unlock commands. CSV export warns that the file is unencrypted.
- Saves go through a temporary file, so a crash can't corrupt the data.
- Generic examples in placeholders and tests.

## 0.1.0 — 2026-11-03

First release.

- Drop emails (Outlook drag, `.eml`/`.msg` files, or a watched folder outside the vault) to import them.
- Sort into categories and sub-categories with keyword, sender and domain filters, checked by priority; unmatched emails go to Uncategorized, where you can build a filter from the email.
- Dashboard with activity over time per category and optional task tracking (Open / Waiting / Done, due dates).
- Stores references only: subject (optional), sender, date, Message-ID and a few keywords. Never saves body, recipients, attachments or the original file.
- No network access, enforced by a build-time scan of `main.js`. HTML is never rendered.
- Pre-commit hook and `.gitignore` block email and data files from the repo; `.gitattributes` keeps LF endings so the hook runs on Windows.
