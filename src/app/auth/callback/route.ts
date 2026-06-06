import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const mode = requestUrl.searchParams.get('mode');
  const requestedRedirectTo = requestUrl.searchParams.get('next') ?? '/';
  const redirectTo = requestedRedirectTo.startsWith('/') ? requestedRedirectTo : '/';
  const responseUrl = new URL(redirectTo, request.url);
  const response = NextResponse.redirect(responseUrl);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!code || !supabaseUrl || !supabasePublishableKey) {
    responseUrl.searchParams.set('auth', 'error');
    return NextResponse.redirect(responseUrl);
  }

  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });

        Object.entries(headers).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
      },
    },
  });

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  responseUrl.searchParams.set('auth', error ? 'error' : mode === 'recovery' ? 'recovery' : 'verified');
  response.headers.set('Location', responseUrl.toString());

  return response;
}
