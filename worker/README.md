# 今日任务 Worker

This Worker is intentionally a shared mirror, not a cloud Todo database. A
person's local IndexedDB remains the source of truth for editing tasks. D1
stores only the fields needed for the other person to view a task, leave a
comment, and deliver an owner reminder.

## Deploying

1. The checked-in `DB` binding points at the production `stardew-todo` D1
   database. Forks must create their own database and replace `database_id` in
   `wrangler.jsonc`; do not reuse another account's binding ID.
2. Apply migrations with `npx wrangler d1 migrations apply stardew-todo`.
3. Store the Web Push VAPID values as secrets:

   ```text
   npx wrangler secret put VAPID_SUBJECT
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   ```

4. Deploy with `npm run deploy` (the repository workflow supplies the
   Cloudflare API token; no secret belongs in this directory).

Cloudflare Cron invokes `scheduled()` every minute in UTC. The sweep uses
indexed D1 predicates and a short five-minute claim lease before attempting
Web Push. A successful 2xx delivery records `sent_at`; failed or empty
subscription attempts release the claim for a later retry. The stable
`deliveryId` and notification `tag` let the Service Worker merge retries.
External push providers do not provide an absolute exactly-once guarantee.
If a delayed sweep finds that both the normal and overdue times have passed,
the overdue notification takes precedence so the user does not receive two
messages in the same minute.

## API contract

- `GET /health` and `GET /v1/config` are public.
- `POST /v1/spaces` creates a space and returns an access token, pairing token,
  and recovery code once. The latter two are never stored in plaintext.
- `POST /v1/spaces/:spaceId/join` accepts a pairing or recovery token and
  returns a device access token. Pairing joins as `partner`; recovery restores
  an `owner` device.
- `GET /v1/spaces/:spaceId/tasks` and the task detail route are readable by
  both roles. Either role may POST/PUT its own mirror task; an existing task
  can only be updated by the role recorded in its `ownerRole` field.
- `GET/POST /v1/spaces/:spaceId/tasks/:taskId/comments` is append-only and is
  available to both roles.
- `POST/DELETE /v1/spaces/:spaceId/push-subscriptions` stores only the current
  device's subscription and is available to either role. Reminders are routed
  to subscriptions whose device role matches the task's owner role.
- `POST /v1/spaces/:spaceId/push-test` sends a one-off test notification to the
  current device's subscriptions.

All protected routes use `Authorization: Bearer <device access token>`. CORS
allows exact origins listed in `ALLOWED_ORIGINS`; wildcard origins are not
accepted.
