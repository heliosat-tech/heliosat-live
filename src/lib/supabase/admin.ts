import { createServerSupabaseClient } from './server';

type AdminProfile = {
  cargo: string | null;
};

/**
 * DEV-ONLY admin gate bypass. When `HELIOSAT_DISABLE_ADMIN_GATE=true` and we are
 * NOT in a production build, treat the caller as an admin so the playground and
 * its API routes can be opened locally for verification without a Supabase login.
 * The `NODE_ENV !== 'production'` guard means even a leaked flag cannot open a
 * deployed instance.
 */
const ADMIN_GATE_BYPASS =
  process.env.NODE_ENV !== 'production' && process.env.HELIOSAT_DISABLE_ADMIN_GATE === 'true';

export async function getCurrentAdminState() {
  const context = await getCurrentAdminContext();

  return {
    isAdmin: context.isAdmin,
    email: context.email,
  };
}

export async function getCurrentAdminContext() {
  if (ADMIN_GATE_BYPASS) {
    return { isAdmin: true, email: 'dev@local', userId: 'dev-bypass', accessToken: null, supabase: null };
  }

  const supabase = await createServerSupabaseClient();

  if (!supabase) {
    return { isAdmin: false, email: null, userId: null, accessToken: null, supabase: null };
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { isAdmin: false, email: null, userId: null, accessToken: null, supabase };
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { data, error } = await supabase
    .from('profiles')
    .select('cargo')
    .eq('id', user.id)
    .maybeSingle<AdminProfile>();

  return {
    isAdmin: !error && data?.cargo === 'admin',
    email: user.email ?? null,
    userId: user.id,
    accessToken: session?.access_token ?? null,
    supabase,
  };
}
