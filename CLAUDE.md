# CLAUDE.md - indiekit-endpoint-webmention-io

This file provides guidance to AI agents working with this Indiekit plugin.

## Package Overview

`@rmdes/indiekit-endpoint-webmention-io` is a comprehensive webmention moderation and management plugin for Indiekit. It syncs webmentions from webmention.io into MongoDB, provides an admin dashboard for moderation, supports domain blocking, privacy removal (GDPR), and exposes a public JSON API as a drop-in replacement for webmention.io's API.

**npm Package:** `@rmdes/indiekit-endpoint-webmention-io`
**Version:** 1.0.4
**Type:** ESM module (`"type": "module"`)
**Mount Path:** `/webmentions` (default, configurable)

## Architecture

### Data Flow

```
webmention.io API (JF2 JSON)
    → Sync Module (background periodic polling)
    → Transform JF2 to MongoDB documents
    → Store in MongoDB "webmentions" collection
    → Dashboard Controller (admin UI, moderation)
    → Public API Controller (JF2 JSON, server-side caching)
```

### Key Components

**Entry Point:** `index.js` - Plugin class, route registration, initialization
**Controllers:**
- `lib/controllers/dashboard.js` - Admin dashboard, hide/unhide, block domain
- `lib/controllers/blocklist.js` - Blocklist management, unblock
- `lib/controllers/sync-controller.js` - Manual sync triggers (incremental/full)
- `lib/controllers/api.js` - Public JSON API (drop-in webmention.io replacement)

**Storage Layer:**
- `lib/storage/webmentions.js` - MongoDB CRUD for webmentions collection
- `lib/storage/blocklist.js` - MongoDB CRUD for webmentionBlocklist collection

**Business Logic:**
- `lib/sync.js` - Background sync scheduler, fetch from webmention.io, blocklist filtering
- `lib/utils.js` - Helper functions (date normalization, HTML sanitization, domain extraction)

**Views:**
- `views/webmentions.njk` - Admin dashboard (paginated list, moderation actions)
- `views/webmentions-blocklist.njk` - Blocklist management page

## MongoDB Schema

### Collection: `webmentions`

```javascript
{
  wmId: 12345,                     // Webmention ID from webmention.io (unique index)
  wmReceived: "2025-02-13T10:00:00.000Z",  // ISO string (indexed)
  wmProperty: "in-reply-to",       // Type: in-reply-to, like-of, repost-of, mention-of, bookmark-of, rsvp
  wmTarget: "https://example.com/post",    // Target URL (indexed with hidden flag)
  authorName: "Author Name",
  authorUrl: "https://author.site/",
  authorPhoto: "https://author.site/photo.jpg",
  sourceUrl: "https://source.site/post",
  sourceDomain: "source.site",     // Extracted domain (indexed)
  published: "2025-02-13T09:00:00.000Z",  // ISO string or null
  contentHtml: "<p>Reply text...</p>",    // Sanitized HTML
  contentText: "Reply text...",           // Plain text
  name: "Post title",              // Optional
  hidden: false,                   // Boolean (indexed)
  hiddenAt: null,                  // ISO string or null
  hiddenReason: null,              // "manual", "blocklist", "privacy"
  syncedAt: "2025-02-13T10:00:00.000Z",  // ISO string
  raw: { ... }                     // Original JF2 entry
}
```

**Indexes:**
- `{ wmId: 1 }` - unique
- `{ wmTarget: 1, hidden: 1 }`
- `{ sourceDomain: 1 }`
- `{ wmReceived: -1 }`

### Collection: `webmentionBlocklist`

```javascript
{
  domain: "spam.example.com",      // Domain (unique index)
  reason: "spam",                  // "spam", "privacy", "manual"
  blockedAt: "2025-02-13T10:00:00.000Z",  // ISO string (indexed)
  mentionsHidden: 5                // Count of mentions hidden/deleted
}
```

**Indexes:**
- `{ domain: 1 }` - unique

## Routes

### Protected (Require Authentication)

All mounted at `/webmentions` by default:

| Method | Path | Controller | Purpose |
|--------|------|------------|---------|
| GET | `/` | `dashboardController.list` | Admin dashboard - paginated webmention list |
| GET | `/blocklist` | `blocklistController.list` | Blocklist management page |
| POST | `/sync` | `syncController.sync` | Trigger incremental sync |
| POST | `/sync/full` | `syncController.fullSync` | Trigger full re-sync (deletes all, re-fetches) |
| POST | `/:wmId/hide` | `dashboardController.hide` | Hide a webmention (mark hidden) |
| POST | `/:wmId/unhide` | `dashboardController.unhide` | Restore a webmention (unmark hidden) |
| POST | `/block` | `dashboardController.blockDomainHandler` | Block domain (hide all + add to blocklist) |
| POST | `/blocklist/:domain/delete` | `blocklistController.unblock` | Unblock domain (remove from blocklist + unhide mentions) |
| POST | `/privacy-remove` | `dashboardController.privacyRemove` | Privacy removal (delete all + block domain) |

### Public (No Authentication)

| Method | Path | Controller | Purpose |
|--------|------|------------|---------|
| GET | `/api/mentions` | `apiController.getMentions` | Public JF2 JSON API (drop-in webmention.io replacement) |

**Public API Query Parameters:**
- `target` - Filter by target URL (with/without trailing slash)
- `wm-property` - Filter by type (in-reply-to, like-of, etc.)
- `per-page` - Items per page (max 10,000, default 50)
- `page` - Page number (0-indexed)

**Response:** JF2 feed format (same as webmention.io):
```json
{
  "type": "feed",
  "name": "Webmentions",
  "children": [
    {
      "type": "entry",
      "wm-id": 12345,
      "wm-received": "2025-02-13T10:00:00.000Z",
      "wm-property": "in-reply-to",
      "wm-target": "https://example.com/post",
      "author": {
        "type": "card",
        "name": "Author",
        "url": "https://author.site/",
        "photo": "https://author.site/photo.jpg"
      },
      "url": "https://source.site/post",
      "published": "2025-02-13T09:00:00.000Z",
      "content": {
        "html": "<p>Reply text...</p>",
        "text": "Reply text..."
      }
    }
  ]
}
```

## Configuration

```javascript
// indiekit.config.js
export default {
  plugins: [
    "@rmdes/indiekit-endpoint-webmention-io",
  ],

  "@rmdes/indiekit-endpoint-webmention-io": {
    mountPath: "/webmentions",  // Optional, default "/webmentions"
    token: process.env.WEBMENTION_IO_TOKEN,  // REQUIRED: webmention.io API token
    domain: "example.com",      // REQUIRED: domain to fetch webmentions for
    syncInterval: 900_000,      // Optional, default 15 minutes (in ms)
    cacheTtl: 60,               // Optional, default 60 seconds (public API cache)
  },
};
```

## Background Sync

The plugin automatically starts a background sync process when MongoDB is available:

1. **Initial sync:** Runs 10 seconds after plugin initialization
2. **Recurring sync:** Runs every `syncInterval` milliseconds (default 15 minutes)
3. **Incremental by default:** Uses `since_id` parameter to only fetch new mentions (based on highest `wmId` in database)
4. **Blocklist filtering:** Fetched mentions are filtered against blocklist before insertion (never stored)
5. **Rate limiting:** 500ms delay between pages during sync

### Sync State

Global sync state tracked in `lib/sync.js`:
```javascript
{
  lastSync: "2025-02-13T10:00:00.000Z",  // ISO string or null
  syncing: false,                         // Boolean (prevents concurrent syncs)
  lastError: null,                        // Error message or null
  mentionsAdded: 0,                       // Count from last sync
  mentionsFiltered: 0                     // Count blocked during last sync
}
```

Access via `getSyncState()` - returns a copy (safe to pass to templates).

## Inter-Plugin Relationships

### Dependencies
- `@indiekit/error` - Error handling
- `@indiekit/frontend` - Nunjucks rendering
- `express` 5.0+ - Routing
- `sanitize-html` - HTML sanitization

### Works With
- **@rmdes/indiekit-endpoint-webmentions-proxy** - Alternative public API (simpler, no MongoDB, proxies webmention.io directly). This plugin's public API can replace the proxy plugin.
- **@rmdes/indiekit-endpoint-webmention-sender** - Sends outgoing webmentions. Independent, no integration needed.
- **@indiekit/frontend** - Uses Nunjucks `mention()` macro for rendering webmentions in dashboard.

## CRITICAL: Date Handling Convention

All dates MUST be stored and passed as ISO 8601 strings. This plugin follows upstream Indiekit's convention.

### The Rule

- **Storage (MongoDB):** Store dates as ISO strings (`new Date().toISOString()`), NEVER as JavaScript `Date` objects
- **Controllers:** Pass date strings through to templates unchanged
- **Templates:** Use the `| date` Nunjucks filter for display formatting (e.g., `{{ value | date("PPp") }}`)
- **Template guards:** Always wrap `| date` in `{% if value %}` to protect against null/undefined

### Implementation in This Plugin

**Correct (in `lib/storage/webmentions.js`):**
```javascript
wmReceived: ensureISOString(item["wm-received"]) || new Date().toISOString(),
published: ensureISOString(item.published),
syncedAt: new Date().toISOString(),
hiddenAt: new Date().toISOString(),
```

**Correct (in controllers):**
```javascript
// Pass through unchanged (already ISO strings from storage)
published: ensureISOString(item.published) || ensureISOString(item.wmReceived),
syncState: getSyncState(),  // lastSync is already ISO string
```

**Correct (in templates):**
```nunjucks
{% if syncState.lastSync %}
  {{ syncState.lastSync | date("PPp") }}
{% endif %}
```

### The `ensureISOString()` Utility

MongoDB BSON may auto-convert ISO strings to `Date` objects on retrieval. The `ensureISOString()` function handles this:

```javascript
export const ensureISOString = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
};
```

Use `ensureISOString()` when reading dates from MongoDB or before passing to templates.

## Known Gotchas

### 1. Date Objects Crash Nunjucks `| date` Filter

**Symptom:** `dateString.split is not a function` error in templates

**Cause:** MongoDB auto-converts ISO strings to BSON Date objects. The Nunjucks `| date` filter is `@indiekit/util`'s `formatDate()` which calls `date-fns parseISO(string)`, expecting a string.

**Fix:** Use `ensureISOString()` before passing dates to templates.

### 2. Trailing Slash in Target URL Matching

**Behavior:** The public API query `target` parameter matches both with and without trailing slash:

```javascript
// In getWebmentions()
if (target) {
  const targetClean = target.replace(/\/$/, "");
  query.wmTarget = { $in: [targetClean, targetClean + "/"] };
}
```

This ensures `?target=https://example.com/post` matches mentions stored with or without trailing slash.

### 3. Blocking vs. Privacy Removal

- **Block Domain:** Hides all mentions from domain + adds to blocklist. Mentions remain in database. Can be unhidden later.
- **Privacy Remove:** Permanently deletes all mentions from domain + adds to blocklist. Irreversible (GDPR compliance).

**Implementation:**
- Block: `hideByDomain()` + `blockDomain()` with reason="spam"
- Privacy: `deleteByDomain()` + `blockDomain()` with reason="privacy"

### 4. Full Sync Behavior

Manual full sync (`POST /sync/full`) is destructive:
1. Deletes ALL webmentions in database (`deleteAll()`)
2. Re-fetches ALL webmentions from webmention.io (no `since_id`)
3. Re-applies blocklist filtering during import

**Use case:** Database corruption, testing, initial import. Not for routine use.

### 5. HTML Sanitization

All `content.html` from webmention.io is sanitized via `sanitizeHtml()`:
- Strips empty bridgy links (`<a href="...brid.gy">` with no text)
- Strips empty paragraphs
- Downgrades heading levels (h1→h3, h2→h4, etc.)
- Normalizes `<br><br>` to paragraph breaks

Plain text content is auto-wrapped: `<p>${content.text}</p>`

## Dependencies

```json
{
  "@indiekit/error": "^1.0.0-beta.25",
  "@indiekit/frontend": "^1.0.0-beta.25",
  "express": "^5.0.0",
  "sanitize-html": "^2.14.0"
}
```

**Peer Dependency:** `@indiekit/indiekit` >=1.0.0-beta.25

## Plugin Lifecycle

### `init(Indiekit)`

1. Registers endpoint with Indiekit
2. Adds MongoDB collections: `webmentions`, `webmentionBlocklist`
3. Stores plugin config in `Indiekit.config.application.webmentionConfig`
4. Stores mount path in `Indiekit.config.application.webmentionEndpoint`
5. Stores database getter in `Indiekit.config.application.getWebmentionDb()`
6. Starts background sync if MongoDB is available

### `destroy()`

Stops background sync interval (clears `setInterval`).

## Navigation Item

Adds a navigation item to Indiekit admin sidebar:
```javascript
{
  href: "/webmentions",
  text: "webmention-io.title",  // Localized via locales/en.json
  requiresDatabase: true,        // Hidden if MongoDB not configured
}
```

## Locales

All UI strings are in `locales/en.json`. Key paths:
- `webmention-io.title` - "Webmentions"
- `webmention-io.sync.*` - Sync UI strings
- `webmention-io.filter.*` - Filter dropdown options
- `webmention-io.actions.*` - Button labels
- `webmention-io.blocklist.*` - Blocklist UI strings
- `webmention-io.counts.*` - Count labels

## Testing Recommendations

### Manual Testing Workflow

1. **Initial Setup:**
   - Configure `token` and `domain` in config
   - Start Indiekit with MongoDB
   - Verify background sync starts (check logs for "[Webmentions] Starting background sync")

2. **Sync Testing:**
   - Trigger manual sync: POST `/webmentions/sync`
   - Verify mentions appear in dashboard: GET `/webmentions`
   - Trigger full sync: POST `/webmentions/sync/full` (destructive!)

3. **Moderation Testing:**
   - Hide a mention: POST `/webmentions/:wmId/hide`
   - Verify it's marked hidden in dashboard
   - Unhide: POST `/webmentions/:wmId/unhide`

4. **Blocklist Testing:**
   - Block a domain: POST `/webmentions/block` with `domain=spam.example.com`
   - Verify all mentions from that domain are hidden
   - Verify domain appears in blocklist: GET `/webmentions/blocklist`
   - Unblock: POST `/webmentions/blocklist/spam.example.com/delete`
   - Verify mentions are unhidden (if reason was "blocklist")

5. **Privacy Removal Testing:**
   - Privacy remove: POST `/webmentions/privacy-remove` with `domain=privacy.example.com`
   - Verify mentions are DELETED (not just hidden)
   - Verify domain is in blocklist with reason="privacy"

6. **Public API Testing:**
   - Fetch all: GET `/webmentions/api/mentions?per-page=50&page=0`
   - Filter by target: GET `/webmentions/api/mentions?target=https://example.com/post`
   - Filter by type: GET `/webmentions/api/mentions?wm-property=like-of`
   - Verify JSON response is JF2 format
   - Verify hidden mentions are excluded

### MongoDB Queries for Debugging

```javascript
// Count total mentions
db.webmentions.countDocuments({})

// Count hidden mentions
db.webmentions.countDocuments({ hidden: true })

// Find mentions from a domain
db.webmentions.find({ sourceDomain: "example.com" })

// View blocklist
db.webmentionBlocklist.find({})

// Find mentions with no published date
db.webmentions.find({ published: null })
```

## Common Issues

### "Database unavailable" in dashboard

**Cause:** MongoDB not configured or not connected

**Fix:** Verify `MONGODB_URL` environment variable and MongoDB connection

### Sync never runs

**Cause:** Background sync only starts if `Indiekit.config.application.mongodbUrl` is truthy

**Fix:** Ensure MongoDB is configured at plugin init time

### Mentions appear twice

**Cause:** Duplicate sync (should not happen due to `wmId` unique index)

**Fix:** If this occurs, check for race conditions in sync logic or missing unique index

### Public API returns hidden mentions

**Cause:** `showHidden` parameter not correctly set to `false`

**Fix:** Verify `apiController.getMentions` passes `showHidden: false` to `getWebmentions()`

### Dates crash with "split is not a function"

**Cause:** Date objects passed to Nunjucks `| date` filter instead of ISO strings

**Fix:** Use `ensureISOString()` before passing to templates

## Source of Truth

**Edit here:** `/home/rick/code/indiekit-dev/indiekit-endpoint-webmention-io/`

**Do NOT edit:**
- `indiekit/packages/endpoint-webmention-io/` - Upstream Indiekit (different plugin)
- `indiekit-cloudron/node_modules/@rmdes/indiekit-endpoint-webmention-io/` - Installed copy (read-only)

## Publishing Workflow

1. Edit code in this repo
2. Bump version in `package.json`
3. Commit and push to GitHub
4. **User must run `npm publish`** (requires OTP)
5. Update version in `indiekit-cloudron/Dockerfile` (npm install line)
6. Update `indiekit.config.js.rmendes` if config changed
7. Run `cd /home/rick/code/indiekit-dev/indiekit-cloudron && make prepare && cloudron build --no-cache && cloudron update --app rmendes.net --no-backup`

## Related Files

- `indiekit-cloudron/config/indiekit.config.js.rmendes` - Production config for rmendes.net
- `indiekit-cloudron/nginx.conf` - nginx routes (ensure `/webmentions` is proxied to `:8080`)
- `indiekit-eleventy-theme/src/_includes/macros/mention.njk` - Webmention rendering macro (frontend)
