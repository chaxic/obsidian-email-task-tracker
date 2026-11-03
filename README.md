# Email Task Tracker

> **Status: in development.** This plugin is at an early stage (0.x) and is subject to change. Features, settings and the stored record format may change between versions. Export your records to CSV before updating.

Drop emails into Obsidian and they're sorted into your own categories and child categories by keyword, sender and domain filters. Anything that matches nothing goes to **Uncategorized**, where you can build a filter straight from the email. A dashboard shows activity over time, per category. Any category can be a **task**, whose status (Open / Waiting / Done) follows what its emails say.

The plugin stores only a short reference to each email, never its body or attachments, and can encrypt what it stores. It's desktop-only.

## Installation
- **Community plugins:** in Obsidian, open *Settings → Community plugins → Browse*, search for **Email Task Tracker**, then install and enable it.
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/chaxic/obsidian-email-task-tracker/releases/latest) into `<vault>/.obsidian/plugins/email-task-tracker/`, then enable the plugin under *Settings → Community plugins*.

## What is stored, and what isn't

The plugin reads each email **in memory only** to sort it. It saves a small reference record:

| Saved | Never saved |
|---|---|
| Subject (can be turned off) | Body text or HTML |
| Sender address and domain | Recipients (To/Cc/Bcc) |
| Date, Message-ID | Attachments |
| Up to N single keywords (no numbers; configurable, 0 = none) | The original file |
| Categories, and the task status phrases found in the email (e.g. "resolved") | |

Categories, filters and records live in `.obsidian/plugins/email-task-tracker/records.json` in the vault. Preferences such as dashboard layout live in `data.json` next to it. Nothing else is written, except a CSV file when you export, and a `records.backup-….json` copy if `records.json` is ever found damaged (see *Security controls*). To find the original email, use **Copy search** on a row (paste it into Outlook or Gmail search), or turn on Gmail links.

### Encryption (optional)
*Settings → Encryption → Turn on* encrypts `records.json`. Categories and filters are encrypted too, since they can contain sender addresses. Windows Explorer can still see and open the file, but its contents are unreadable ciphertext.
- **How:** a random AES-256-GCM data key encrypts the data, with a fresh IV on every save. The data key is stored twice, each copy locked by a different key: one made from your passphrase (PBKDF2-SHA-256, 600,000 rounds), and one made from your recovery key.
- **Recovery key:** shown once when you turn encryption on. Keep it in a password manager or print it. On the unlock screen, *Forgot passphrase?* lets you unlock with it and set a new passphrase. Changing your passphrase doesn't invalidate it; *Create new key* does.
- **Unlocking:** once per session. The keys exist only in memory.
- **Auto-lock:** after 15, 30 or 60 idle minutes. *Lock now* is a command. Locking writes the encrypted file first, and only reports "locked" once the data is gone from memory.
- **Sensitive changes ask for your passphrase.** Creating a recovery key, changing the passphrase and turning encryption off need the current passphrase (or the recovery key), not just an unlocked session.
- **If encryption disappears, you're told.** If `records.json` turns up unencrypted or missing while encryption was on (for example, replaced by a sync conflict or an old backup), the plugin warns you instead of quietly saving plain text.
- **If you lose both the passphrase and the recovery key, the data cannot be recovered.**
- **CSV exports are plain text.** You're warned on export; delete them when done.
- **Earlier plain copies aren't erased.** Turning encryption on doesn't remove unencrypted copies made before, such as in sync history, backups, or the old file's space on disk.

The plugin works fully offline. It never connects to anything.

## Disclosures
- **No network access and no telemetry.** The plugin never makes network requests or collects usage data.
- **Files outside the vault.** If you set a drop folder, the plugin reads `.eml`/`.msg` files from that folder, and only that folder. With *Delete files after import* turned on (off by default), it **permanently deletes** each file there once the email is tracked.
- **Email drops anywhere in Obsidian.** `.eml` and `.msg` files dropped anywhere in Obsidian, including pop-out windows, are imported by this plugin instead of being saved into the vault. Other files are left alone.
- **Links and clipboard.** *Open in Gmail* (off by default) opens your browser, and *Copy search* and the recovery key's *Copy* button write to your clipboard. Each only happens when you click it.
- **Desktop only.** Uses Node's file system access for the drop folder.
- **Storage and sync.** Without encryption, records are stored as plain text in the plugin folder. If Obsidian Sync (or another sync tool) includes plugin folders, `records.json` syncs with them. *Export to CSV* writes subjects and senders to a file in the vault root.
- **Uninstalling deletes your records.** Removing the plugin deletes its folder, including `records.json`. Export to CSV first if you want to keep them.

### Security controls
- **No network access.** `npm run build` scans the bundled `main.js` and fails if it finds `fetch`, `XMLHttpRequest`, `WebSocket`, `requestUrl`, workers, WebRTC, `src` assignments, remote CSS `url()`s, Node network modules, dynamic `import()` or unexpected URLs. This covers dependencies too.
- **HTML is never rendered.** It's converted to text with an inert `DOMParser` document, so tracking pixels and remote images never load.
- **Stored data is validated.** Settings, categories and records are checked when loaded. Colours must be plain hex values, so an edited or synced file can't inject CSS that loads a remote resource. If `records.json` can't be read, or some entries are damaged, a `records.backup-….json` copy is kept and you're told, instead of the plugin failing to start.
- **No accidental copies.** Email files dropped anywhere in Obsidian, pop-out windows included, are captured before the editor or file explorer can save them into the vault.
- **Size limit.** Files over 50 MB are rejected before they're read.
- **Repo hygiene.** `.gitignore` and a pre-commit hook (`.githooks/pre-commit`) block `.eml`, `.msg`, `.csv`, `data.json` and every `records*.json` file, including temporary and backup copies. Test fixtures are synthetic.
- **Recommended:** turn on BitLocker for the drive holding the vault, and keep the vault out of cloud sync, or exclude the plugin folder from it.

## Getting emails in
- **Classic Outlook (Windows):** drag a message onto the dashboard drop zone, or anywhere in Obsidian. If nothing happens, turn on *Settings → Drop diagnostics*, try again, and note what it reports. Fallback: drag the message to a folder (Outlook saves a `.msg`), then drop that file in, or use the drop folder.
- **Gmail (web):** open the email → ⋮ → *Download message* → drop the `.eml` file.
- **Drop folder (optional):** set a folder **outside** the vault in settings. New `.eml`/`.msg` files there are imported automatically, and can be deleted afterwards.

## Filters
Each category has a filter. Every section you fill in must match:
- **Contains any of**: at least one keyword or phrase.
- **Contains all of**: every keyword.
- **Never if it contains**: excludes.
- **From these addresses / domains**: domains include subdomains.
- **Look for keywords in**: subject, body, sender name.

An email gets **every** category whose filter matches, so it can be in several at once.

**Child categories can have several parents.** For example, *Unity* can sit under both *Gaming* and *Software*. A matching email then counts under each parent.
- A parent with **no filter** is a group: it collects its child categories.
- A parent **with** a filter must also match for an email to count through it.
- In the category editor, *Relationships* sets both parents and child categories, and can create new ones.

Manage categories from the dashboard's category list (hover for edit / add / delete, right-click for more) or from *Settings → Email Task Tracker*. Use the pencil in the *Categories* column of the table to place an email by hand.

New imports are matched against the full email. Re-running filters on past emails can only use what was stored (subject, sender, keywords). Emails you assign by hand are never moved by re-runs.

## Tasks
Turn on **Treat as a task** for a category (marked with a clipboard icon). The category *is* the task, and its emails, including those in its child categories, are the task's activity.
- **Automatic status:** each task has phrases for *Done* (default: resolved, completed, closed), *Waiting* (waiting for, waiting on, pending, on hold) and *Reopen* (reopened, not resolved, still not working, still an issue). The status follows the newest email that contains one.
- **Which phrase counts:** the longest phrase wins, so "not resolved" beats "resolved". Quoted reply history is ignored, so an old "is this resolved?" doesn't count.
- **Milestones:** an ordered list of phrases (e.g. approved, ordered, delivered). Each is ticked off, with its date, the first time an email mentions it, and progress shows as ●●○ 2/3.
- **Manual status:** set it yourself in the Tasks card. It holds until a newer email changes it; choose *Automatic* to hand back control.
- **Tasks card:** the dashboard lists every task with its status and why ("'resolved' on 3 Nov"), progress, email count, last activity, days open and due date. Click a task to see its emails as a timeline. The *Signal* column shows what each email contributed.
- **Search** covers status and milestone phrases, so searching "approved" finds the emails that moved a task forward.

Phrases are detected in the full email at import. Phrases added later are checked against past emails' stored subject and keywords.

## Dashboard charts
Use **Add chart**, then each chart's ⋯ menu to pick a type, style, width and position. Every chart follows the dashboard filters: category, status, period and search.
- **Activity over time:** stacked bars, grouped bars or lines.
- **Share by category:** ranked bars or donut.
- **Heatmaps:** category × period, busiest days and hours, or a calendar.
- **Top senders:** by address or by domain.
- **Tasks by status:** one bar per task, coloured and labelled by status.

## Verify a release
Releases are built by GitHub Actions from the tagged source, with a signed build provenance attestation. To check that a downloaded `main.js` came from this repository:
```sh
gh attestation verify main.js -R chaxic/obsidian-email-task-tracker
```

## Development
```sh
npm install
git config core.hooksPath .githooks   # once per clone: turns on the pre-commit hook
npm test          # vitest: parsing, classification, tasks, encryption and recovery, validation, storage-minimisation checks
npm run build     # type-check, bundle, network guard
OBSIDIAN_VAULT=/path/to/test/vault npm run deploy   # build + copy into that vault
npm audit
```
After deploying, reload Obsidian (or toggle the plugin off and on) under *Settings → Community plugins*.

Security issues: see [SECURITY.md](SECURITY.md).

## License
[MIT](LICENSE). Bundled third-party code is listed, with its licenses, in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
