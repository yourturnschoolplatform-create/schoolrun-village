import { Router, type Request } from 'express';
import { createRequestScopedSupabaseClient, RequestAuthenticationError } from './supabase/request-client.js';

export class MatchInputError extends Error {}
type Context = { userId: string; client: ReturnType<typeof createRequestScopedSupabaseClient> };

async function context(request: Request): Promise<Context> {
  const client = createRequestScopedSupabaseClient(request);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new RequestAuthenticationError();
  return { client, userId: data.user.id };
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new MatchInputError('Invalid match identifier.');
  return value;
}
function noStore(response: { setHeader: (key: string, value: string) => void }) { response.setHeader('Cache-Control', 'no-store, max-age=0'); }

export function createMatchesRouter(): Router {
  const router = Router();
  router.get('/candidates', async (request, response, next) => { try {
    const ctx = await context(request); const allowDifferent = request.query.differentDates === 'true';
    const [candidates, tracked] = await Promise.all([
      ctx.client.rpc('get_reciprocal_match_candidates', { p_allow_different_date: allowDifferent }),
      ctx.client.rpc('record_first_match_viewed'),
    ]);
    if (candidates.error) throw candidates.error; if (tracked.error) throw tracked.error;
    noStore(response); response.json({ candidates: candidates.data ?? [] });
  } catch (error) { next(error); } });
  router.get('/swaps', async (request, response, next) => { try {
    const ctx = await context(request); const expired = await ctx.client.rpc('expire_my_swap_proposals'); if (expired.error) throw expired.error;
    const swaps = await ctx.client.rpc('list_my_swaps'); if (swaps.error) throw swaps.error;
    noStore(response); response.json({ swaps: swaps.data ?? [] });
  } catch (error) { next(error); } });
  router.post('/proposals', async (request, response, next) => { try {
    const ctx = await context(request); const body = request.body ?? {};
    const result = await ctx.client.rpc('propose_reciprocal_swap', { p_viewer_need: uuid(body.viewerNeedInstanceId), p_candidate_help: uuid(body.candidateHelpInstanceId), p_candidate_need: uuid(body.candidateNeedInstanceId), p_viewer_help: uuid(body.viewerHelpInstanceId), p_allow_different_date: Boolean(body.allowDifferentDate) });
    if (result.error) throw result.error; noStore(response); response.status(201).json({ swapId: result.data, status: 'proposed' });
  } catch (error) { next(error); } });
  router.post('/swaps/:swapId/:action', async (request, response, next) => { try {
    const action = request.params.action; if (!['accept', 'decline', 'withdraw'].includes(action)) throw new MatchInputError('Invalid swap action.');
    const ctx = await context(request); const result = await ctx.client.rpc('transition_swap_proposal', { p_swap: uuid(request.params.swapId), p_action: action });
    if (result.error) throw result.error; noStore(response); response.json({ status: result.data });
  } catch (error) { next(error); } });
  router.post('/blocks', async (request, response, next) => { try {
    const ctx = await context(request); const result = await ctx.client.rpc('block_match_user', { p_blocked: uuid(request.body?.candidateId) });
    if (result.error) throw result.error; noStore(response); response.status(201).json({ status: 'blocked' });
  } catch (error) { next(error); } });
  router.get('/swaps/:swapId/children', async (request, response, next) => { try {
    const ctx = await context(request); const result = await ctx.client.rpc('get_accepted_swap_children', { p_swap: uuid(request.params.swapId) });
    if (result.error) throw result.error; noStore(response); response.json({ children: result.data ?? [] });
  } catch (error) { next(error); } });
  return router;
}
