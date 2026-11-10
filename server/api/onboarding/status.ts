import type { Request, Response, NextFunction } from 'express';
import type { User } from '@supabase/supabase-js';
import { createRequestScopedSupabaseClient, RequestAuthenticationError } from '../../supabase/request-client.js';

type SignedInContext = {
  user: User;
  client: ReturnType<typeof createRequestScopedSupabaseClient>;
};

async function signedInContext(request: Request): Promise<SignedInContext> {
  const client = createRequestScopedSupabaseClient(request);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new RequestAuthenticationError();
  return { client, user: data.user };
}

/**
 * GET /api/onboarding/status
 * Returns onboarding progress for the signed-in parent (email, OAuth, or either).
 * Always JSON — never an HTML SPA 404 for this path when Express is running.
 */
export async function handleOnboardingStatus(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  if (request.method !== 'GET') {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const context = await signedInContext(request);
    const [
      profileResult,
      membershipResult,
      consentResult,
      documentResult,
      childResult,
      declarationResult,
      rolesResult,
    ] = await Promise.all([
      context.client
        .from('profiles')
        .select('id, display_name')
        .eq('id', context.user.id)
        .maybeSingle(),
      context.client
        .from('school_memberships')
        .select('id, school_id, status, approved_at')
        .eq('user_id', context.user.id)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
      context.client.from('consent_acceptances').select('document_id').eq('user_id', context.user.id),
      context.client
        .from('consent_documents')
        .select('id, document_type, version, title, summary')
        .eq('is_active', true)
        .order('document_type'),
      context.client.from('child_profiles').select('id').eq('parent_id', context.user.id),
      context.client.from('safety_declarations').select('id, declaration_version_id').eq('parent_id', context.user.id),
      context.client.from('role_assignments').select('role, school_id').eq('user_id', context.user.id).is('revoked_at', null),
    ]);

    for (const result of [profileResult, membershipResult, consentResult, documentResult, childResult, declarationResult, rolesResult]) {
      if (result.error) throw result.error;
    }

    // Soft-fail: brand-new social sign-ups may briefly lag profile/ledger rows.
    if (context.user.email_confirmed_at) {
      const eventResult = await context.client.rpc('record_email_verified_event');
      if (eventResult.error) {
        // Status payload is still useful; do not 500 the SPA boot path.
      }
    }

    let currentSafetyDeclaration: { id: string; title: string; summary: string } | null = null;
    if (membershipResult.data?.status === 'verified') {
      const { data, error } = await context.client
        .from('safety_declaration_versions')
        .select('id, title, summary')
        .eq('is_published', true)
        .or(`school_id.is.null,school_id.eq.${membershipResult.data.school_id}`)
        .order('school_id', { ascending: false, nullsFirst: false })
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      currentSafetyDeclaration = data;
    }

    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.status(200).json({
      emailVerified: Boolean(context.user.email_confirmed_at),
      profile: profileResult.data
        ? {
            displayName: profileResult.data.display_name,
            // Day-1 select is id/display_name only; Day-15 fields stay defaulted when absent.
            accountStatus: 'PENDING_VERIFICATION',
            accountRole: 'PARENT',
            schoolId: null,
            verifiedAt: null,
            suburb: null,
            schoolLabel: null,
          }
        : null,
      membership: membershipResult.data
        ? {
            id: membershipResult.data.id,
            status: membershipResult.data.status,
            approved_at: membershipResult.data.approved_at,
          }
        : null,
      consentDocuments: documentResult.data ?? [],
      acceptedConsentDocumentIds: (consentResult.data ?? []).map((item) => item.document_id),
      childCount: (childResult.data ?? []).length,
      safetyDeclarationIds: (declarationResult.data ?? []).map((item) => item.declaration_version_id),
      currentSafetyDeclaration,
      roles: rolesResult.data ?? [],
    });
  } catch (error) {
    next(error);
  }
}
