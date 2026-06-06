import Link from 'next/link';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ConsoleScreen } from '@/components/console/ConsoleScreen';
import { getCurrentAdminState } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

function Unauthorized() {
  return (
    <AppShell>
      <main className="grid min-h-0 flex-1 place-items-center">
        <section className="w-full max-w-md rounded-lg border border-slate-700/50 bg-slate-900/40 p-6 text-center shadow-2xl backdrop-blur-xl">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-slate-700 bg-slate-950/70 text-slate-400">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-slate-100">Admin requerido</h1>
          <p className="mt-2 text-sm text-slate-400">Esta pantalla solo esta disponible para perfiles con cargo admin.</p>
          <Link href="/" className="mt-5 inline-flex h-10 items-center gap-2 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-4 text-sm text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/15">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Volver</span>
          </Link>
        </section>
      </main>
    </AppShell>
  );
}

export default async function ConsolePage() {
  const adminState = await getCurrentAdminState();
  if (!adminState.isAdmin) {
    return <Unauthorized />;
  }

  return (
    <AppShell>
      <ConsoleScreen />
    </AppShell>
  );
}
