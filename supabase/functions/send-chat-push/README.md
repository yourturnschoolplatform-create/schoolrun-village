# send-chat-push

Supabase Edge Function that delivers Karrot-style Web Push alerts for chat messages and pickup matches.

## Secrets

Set in the Supabase project (Dashboard → Edge Functions → Secrets, or `supabase secrets set`):

| Name | Required | Notes |
| --- | --- | --- |
| `VAPID_PRIVATE_KEY` | yes | Pair with the public key used by the SPA |
| `VITE_VAPID_PUBLIC_KEY` or `VAPID_PUBLIC_KEY` | yes | Same value as browser `VITE_VAPID_PUBLIC_KEY` |
| `VAPID_SUBJECT` | no | Defaults to `mailto:support@schoolrunvillage.local` |
| `SUPABASE_URL` | auto | Usually injected |
| `SUPABASE_ANON_KEY` | auto | Usually injected |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Deletes expired (404/410) rows in `push_subscriptions` |

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

Expired push endpoints (HTTP 404/410 from the push service) are removed from `public.push_subscriptions`.
