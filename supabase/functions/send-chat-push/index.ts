/**
 * SchoolRun Village — send Web Push for chat / pickup-match alerts.
 *
 * Secrets (Deno.env):
 *   VAPID_PRIVATE_KEY
 *   VITE_VAPID_PUBLIC_KEY or VAPID_PUBLIC_KEY
 *   VAPID_SUBJECT (optional, default mailto:)
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *
 * POST JSON:
 *   { kind: "chat", roomId, preview? }
 *   { kind: "match", requestId, roomId? }
 *
 * Caller must send Authorization: Bearer <user JWT>.
 * Expired endpoints (404/410) are removed from push_subscriptions.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@4.0.0";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type PushTarget = {
  endpoint?: unknown;
  p256dh?: unknown;
  auth?: unknown;
};

type NotifyBody = {
  kind?: unknown;
  roomId?: unknown;
  requestId?: unknown;
  preview?: unknown;
  title?: unknown;
  body?: unknown;
};

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function env(name: string): string {
  return Deno.env.get(name)?.trim() ?? "";
}

function readVapid(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = env("VITE_VAPID_PUBLIC_KEY") || env("VAPID_PUBLIC_KEY");
  const privateKey = env("VAPID_PRIVATE_KEY");
  const subject = env("VAPID_SUBJECT") || "mailto:support@schoolrunvillage.local";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function safePreview(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 120).replace(/\+?\d[\d\s()-]{7,}\d/g, "•••");
}

function asTargets(raw: unknown): PushTarget[] {
  if (!raw || typeof raw !== "object") return [];
  const bag = raw as { subscriptions?: unknown };
  return Array.isArray(bag.subscriptions) ? bag.subscriptions as PushTarget[] : [];
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  const vapid = readVapid();
  if (!vapid) {
    return json(503, { error: "vapid_not_configured" });
  }

  const supabaseUrl = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(503, { error: "supabase_env_missing" });
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+/i.test(authHeader)) {
    return json(401, { error: "authentication_required" });
  }

  let body: NotifyBody;
  try {
    body = await request.json() as NotifyBody;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const kind = typeof body.kind === "string" ? body.kind : "";
  if (kind !== "chat" && kind !== "match") {
    return json(400, { error: "invalid_kind" });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let targets: PushTarget[] = [];
  let payload: Record<string, unknown>;

  if (kind === "chat") {
    if (!isUuid(body.roomId)) return json(400, { error: "invalid_room_id" });
    const roomId = body.roomId;
    const preview = safePreview(body.preview, "New message");
    const { data, error } = await userClient.rpc("list_push_targets_for_chat_peer", {
      p_room_id: roomId,
    });
    if (error) {
      console.error("list_push_targets_for_chat_peer", error.code ?? "error");
      return json(403, { error: "chat_push_unavailable" });
    }
    targets = asTargets(data);
    payload = {
      title: typeof body.title === "string" ? body.title.slice(0, 80) : "New message",
      body: preview,
      roomId,
      kind: "chat",
      url: `/messages?openChat=${roomId}`,
    };
  } else {
    if (!isUuid(body.requestId)) return json(400, { error: "invalid_request_id" });
    const requestId = body.requestId;
    const roomId = isUuid(body.roomId) ? body.roomId : null;
    const { data, error } = await userClient.rpc("list_push_targets_for_pickup_peer", {
      p_request_id: requestId,
    });
    if (error) {
      console.error("list_push_targets_for_pickup_peer", error.code ?? "error");
      return json(403, { error: "match_push_unavailable" });
    }
    const bag = (data ?? {}) as { chatRoomId?: unknown; subscriptions?: unknown };
    targets = asTargets(data);
    const openRoom = roomId
      || (typeof bag.chatRoomId === "string" && isUuid(bag.chatRoomId) ? bag.chatRoomId : null);
    payload = {
      title: typeof body.title === "string" ? body.title.slice(0, 80) : "Pickup match",
      body: safePreview(body.body ?? body.preview, "Your instant pickup was matched. Open chat when ready."),
      roomId: openRoom,
      requestId,
      kind: "match",
      url: openRoom ? `/messages?openChat=${openRoom}` : "/messages",
    };
  }

  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  let sent = 0;
  const gone: string[] = [];

  await Promise.all(targets.map(async (target) => {
    if (
      typeof target.endpoint !== "string"
      || typeof target.p256dh !== "string"
      || typeof target.auth !== "string"
    ) return;

    try {
      await webpush.sendNotification(
        {
          endpoint: target.endpoint,
          keys: { p256dh: target.p256dh, auth: target.auth },
        },
        JSON.stringify(payload),
        { TTL: 60 * 60 },
      );
      sent += 1;
    } catch (error) {
      const status = typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 0;
      if (status === 404 || status === 410) {
        gone.push(target.endpoint);
      }
    }
  }));

  // Clean expired / unsubscribed endpoints (service role bypasses RLS).
  if (gone.length > 0) {
    const { error: cleanupError } = await admin
      .from("push_subscriptions")
      .delete()
      .in("endpoint", gone);
    if (cleanupError) {
      console.error("push_subscriptions cleanup", cleanupError.code ?? "error");
    }
  }

  return json(200, {
    ok: true,
    sent,
    cleaned: gone.length,
  });
});
