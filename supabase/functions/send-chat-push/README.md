# send-chat-push

Supabase Edge Function that delivers Web Push alerts for chat messages and pickup matches.

Uses `@block65/webcrypto-web-push` (Web Crypto). Do **not** use Node `web-push` here — Deno lacks `crypto.ECDH`.

## Secrets

Set in the Supabase project (Dashboard → Edge Functions → Secrets, or `supabase secrets set`):

| Name | Required | Notes |
| --- | --- | --- |
| `VAPID_PRIVATE_KEY` | yes | Must pair with the **same** public key the SPA uses to subscribe |
| `VITE_VAPID_PUBLIC_KEY` or `VAPID_PUBLIC_KEY` | yes | Same value as browser `VITE_VAPID_PUBLIC_KEY` (URL-safe base64, no quotes) |
| `VAPID_SUBJECT` | no | Contact URI: `mailto:you@example.com` or `https://…`. Bare emails get `mailto:` prefixed. Default: `mailto:support@schoolrunvillage.local` |
| `SUPABASE_URL` | auto | Usually injected |
| `SUPABASE_ANON_KEY` | auto | Usually injected |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Deletes stale rows in `push_subscriptions` |

```bash
supabase secrets set VAPID_PRIVATE_KEY="..." VITE_VAPID_PUBLIC_KEY="..." VAPID_SUBJECT="mailto:support@yourdomain.com"
```

Generate a matching pair once (do not mix keys from different `web-push generate-vapid-keys` runs):

```bash
npx web-push generate-vapid-keys
```

Put the **public** key in the SPA env (`VITE_VAPID_PUBLIC_KEY`) **and** Edge secrets. Put the **private** key only in Edge/server secrets.

## Deploy

```bash
supabase functions deploy send-chat-push
```

## Call

```http
POST /functions/v1/send-chat-push
Authorization: Bearer <user-access-token>
Content-Type: application/json

{ "kind": "chat", "roomId": "<uuid>", "preview": "Hello" }
```

```json
{ "kind": "match", "requestId": "<uuid>", "roomId": "<uuid?>" }
```

## Failure codes from push services

| Status | Meaning | Action |
| --- | --- | --- |
| `201` / `2xx` | Delivered | Counted in `sent` |
| `404` / `410` | Subscription expired | Endpoint deleted from `push_subscriptions` |
| `403` | Forbidden — usually **VAPID public/private mismatch** vs the key used at subscribe time, or unauthorized sender | Endpoint deleted; peer must **Enable alerts** again with the current public key |
| other | Logged as `webpush_send_failed` | Batch continues; function still returns HTTP 200 with `sent` / `failed` / `cleaned` |

One bad subscription never aborts the whole send.
