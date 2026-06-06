"use client";

import { ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type AdminProfile = {
  cargo: string | null;
};

export function AdminIndicator() {
  const supabase = useMemo(() => createClient(), []);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let isMounted = true;

    const loadAdminStatus = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!isMounted || !user) {
        setIsAdmin(false);
        return;
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('cargo')
        .eq('id', user.id)
        .maybeSingle<AdminProfile>();

      if (!isMounted) {
        return;
      }

      setIsAdmin(!error && data?.cargo === 'admin');
    };

    void loadAdminStatus();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void loadAdminStatus();
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  if (!isAdmin) {
    return null;
  }

  return (
    <div
      aria-label="Usuario administrador"
      title="Usuario administrador"
      className="flex h-10 items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-4 text-sm font-medium text-emerald-100 shadow-[0_0_20px_rgba(52,211,153,0.12)]"
    >
      <ShieldCheck className="h-4 w-4 text-emerald-300" aria-hidden="true" />
      <span>Admin</span>
    </div>
  );
}
