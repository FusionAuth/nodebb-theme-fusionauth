# FusionAuth Theme for NodeBB

This is the theme for the FusionAuth community forums: https://fusionauth.io/community/forum/

Version 3 of the theme targets NodeBB 4.16 and later 4.x releases. Use version 2 for NodeBB 3.x.

## Local Docker deployment

The included Compose configuration runs NodeBB 4.16.9 and Redis with persistent Docker volumes.
It binds the forum to localhost and is intended for local development, not production.

From the repository root, start it with `docker compose -f test/compose.yaml up -d`
and open http://localhost:4567. On a fresh
installation, use the web installer with Redis at host `redis`, port `6379`, and
database `0`. After setup, restart NodeBB so it installs the local theme:

```sh
docker compose -f test/compose.yaml restart nodebb
docker compose -f test/compose.yaml exec nodebb ./nodebb activate nodebb-theme-fusionauth --config=/opt/config/config.json
docker compose -f test/compose.yaml restart nodebb
```

Wait for NodeBB to finish building before running the activation command or
opening the forum. The theme is mounted from this checkout; restart NodeBB to
rebuild after changing it. `docker compose -f test/compose.yaml down` stops the services without
deleting their data. Web push requires HTTPS and is unavailable on localhost HTTP.

### Sync production appearance

With the local forum running and the FusionAuth theme active, set
`NODEBB_SOURCE_API_KEY` in your environment to a forum administrator API key,
then run `node test/sync-scripts/sync-appearance.js` from the repository root. The script reads the source forum,
updates the local Docker instance, and restarts it. Do not commit the key.

The script imports the exposed title, skin and Persona options, the rendered
custom CSS, and the published forum logo. It does not import custom HTML or
JavaScript, authentication, integrations, secrets, other assets, or settings
that the API does not expose. CSS is imported as rendered CSS rather than the
original SCSS; CSS containing imports or URLs must be reviewed manually. The
source forum uses NodeBB 3, so some styling may not apply to NodeBB 4.

### Sync production forum configuration

With the local forum running, set `NODEBB_SOURCE_API_KEY` to a production
administrator API key in your environment. Node.js 18 or later is required on
the host. From the repository root:

```sh
# Preview changes without writing locally.
node test/sync-scripts/sync-forum.js

# After reviewing the preview and backing up local data:
node test/sync-scripts/sync-forum.js --apply
```

To also create missing users referenced by memberships or privileges, preview
with `node test/sync-scripts/sync-forum.js --import-users`, then set
`NODEBB_IMPORT_PASSWORD` in your environment and add `--import-users` to the
apply command. Existing users' passwords are never changed. Only usernames are
imported, without email addresses or other profile data.

**Local testing only:** imported users can receive production administrator
privileges. A shared weak password such as `password` makes those accounts easy
to compromise. Keep the forum bound to localhost, never use this on a
production or shared forum, and replace weak passwords before exposing it.
For imported users only, the script bypasses NodeBB's password-strength check
in its own process; it does not change the forum's persisted password policy.

The source is read-only: production requests use GET and do not follow
redirects. No destination API key is needed; changes use the local container's
NodeBB database connection. The apply operation is not transactional, so back up
the local Redis data and NodeBB volumes before running it. It restarts the local
forum after applying changes.

The sync merges categories, groups, memberships, category and global privileges,
and compatible plugins. It retains local-only categories, groups, and
principals. Matching uses category name and parent (then a saved local mapping),
group name, and exact username. Existing matching users receive memberships and
privilege grants or removals; missing usernames are printed and, unless
`--import-users` is supplied, not created.
Memberships are added, not removed. Category and group images, group owners,
plugin settings, and production credentials are not copied.

Plugins must declare compatibility with the local NodeBB version. Incompatible
or unverified plugins remain disabled; integration and other unreviewed plugins
are also left disabled even if active in production. Review the warnings and
configure any desired integrations manually. Never commit API keys.

### Import production topics

First apply the forum configuration sync so every category has a local mapping.
With `NODEBB_SOURCE_API_KEY` set and the local forum running, preview the topic
import:

```sh
node test/sync-scripts/sync-topics.js
```

After backing up local Redis and NodeBB volumes, set `NODEBB_IMPORT_PASSWORD` and
run `node test/sync-scripts/sync-topics.js --apply`. The import reads production
using GET only and restarts the local forum afterward.

The script selects the newest 40 non-deleted topics by creation time per
category, then processes one topic per category per round. It imports the raw
post text, replies, authors, timestamps, and available reply-to relationships.
Missing authors are created locally with the supplied password; existing
accounts and passwords are left alone. Posts from deleted production accounts
are imported anonymously. The local-only weak-password warning
above also applies here.

Source-to-local ID mappings prevent duplicate imports on subsequent runs and
allow newly added replies to be imported. Already imported content is not
updated if edited or deleted in production. Deleted topics are excluded and a
deleted reply is skipped; replies to it are imported without a parent link.
An inaccessible post or deleted main post stops the import. Attachments,
images, votes, topic tags, moderation
state, and user profile details are not copied.

The import is not transactional. If interrupted during an individual database
write, it stops on retry rather than duplicating that item; inspect the local
state and restore your backup before retrying. Do not run imports concurrently.

## Theme update

The theme is here: https://github.com/FusionAuth/nodebb-theme-fusionauth/

Here's theming docs: https://docs.nodebb.org/development/themes/

If you want to change the theme:

* make changes to the repo, including bumping the version
* push changes to main
* publish the theme to npm
* submit a support ticket with nodebb telling them the theme version we want to upgrade to
* wait a few days

### Credits

Material theme by [pichalite](https://github.com/pichalite).

