import { createServerOnlyAdminClient } from './service-role.js';

export type BootstrapAdminResult = {
  outcome: 'created' | 'already-active';
  userId: string;
};

async function findUserIdByEmail(email: string): Promise<string> {
  const admin = createServerOnlyAdminClient();
  let page = 1;

  while (page <= 100) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw error;

    const matchingUser = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (matchingUser) return matchingUser.id;
    if (data.users.length < 100) break;
    page += 1;
  }

  throw new Error('YOURTURN_ADMIN_EMAIL does not match an existing Supabase Auth user.');
}

export async function bootstrapFirstAdmin(email = process.env.YOURTURN_ADMIN_EMAIL?.trim()): Promise<BootstrapAdminResult> {
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error('YOURTURN_ADMIN_EMAIL must be a valid configured email address.');
  }

  const admin = createServerOnlyAdminClient();
  const userId = await findUserIdByEmail(email);
  const { data: outcome, error } = await admin.rpc('bootstrap_first_admin', { p_user_id: userId });
  if (error) throw error;
  if (outcome !== 'created' && outcome !== 'already_active') {
    throw new Error('Unexpected administrator bootstrap result.');
  }
  return { outcome: outcome === 'created' ? 'created' : 'already-active', userId };
}
