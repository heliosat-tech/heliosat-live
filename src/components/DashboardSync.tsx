"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useSatelliteConfig } from '@/contexts/SatelliteConfigContext';
import { useSatelliteWatch } from '@/contexts/SatelliteWatchContext';
import { loadDashboardConfig, saveDashboardConfig } from '@/services/watchPersistenceService';

const SAVE_DEBOUNCE_MS = 800;

/**
 * Syncs the dashboard watch-list (tracked satellites + instruments/thresholds) with Supabase per
 * account. Renders nothing.
 *  - On sign-in: loads the user's saved config and hydrates both contexts. If the account has no
 *    row yet, it adopts whatever is currently loaded locally (migrates the localStorage cache up).
 *  - On change (while signed in): debounced upsert to the user's row.
 *  - Signed out / no Supabase env: does nothing; the contexts keep their localStorage behaviour.
 */
export function DashboardSync() {
  const supabase = useMemo(() => createClient(), []);
  const { trackedTles, replaceTrackedTles } = useSatelliteConfig();
  const { config, replaceConfig } = useSatelliteWatch();

  const [userId, setUserId] = useState<string | null>(null);

  // Latest values, read inside async effects without making them dependencies.
  const trackedRef = useRef(trackedTles);
  const configRef = useRef(config);
  useEffect(() => {
    trackedRef.current = trackedTles;
    configRef.current = config;
  }, [trackedTles, config]);

  // Guards against the load→change→save loop and redundant writes.
  const syncedUserRef = useRef<string | null>(null);
  const lastSavedRef = useRef<string>('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track the authenticated user.
  useEffect(() => {
    if (!supabase) return;
    let active = true;

    void supabase.auth.getUser().then(({ data }) => {
      if (active) setUserId(data.user?.id ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  // Initial load (or local→account migration) whenever the signed-in user changes.
  useEffect(() => {
    if (!supabase || !userId) return;
    let cancelled = false;

    void (async () => {
      const remote = await loadDashboardConfig(supabase, userId);
      if (cancelled) return;

      const hasRemote = remote && (remote.tracked.length > 0 || Object.keys(remote.instruments).length > 0);
      if (hasRemote) {
        // Hydrate from the account; pre-set lastSaved so the save effect doesn't echo it back.
        lastSavedRef.current = JSON.stringify({ tracked: remote!.tracked, instruments: remote!.instruments });
        replaceTrackedTles(remote!.tracked);
        replaceConfig(remote!.instruments);
      } else {
        // No saved row yet → adopt the current local state for this account.
        const local = { tracked: trackedRef.current, instruments: configRef.current };
        lastSavedRef.current = JSON.stringify(local);
        if (local.tracked.length > 0 || Object.keys(local.instruments).length > 0) {
          await saveDashboardConfig(supabase, userId, local);
        }
      }
      syncedUserRef.current = userId;
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase, userId, replaceTrackedTles, replaceConfig]);

  // Debounced save on change, once the initial sync for this user is done.
  useEffect(() => {
    if (!supabase || !userId || syncedUserRef.current !== userId) return;

    const payload = { tracked: trackedTles, instruments: config };
    const serialized = JSON.stringify(payload);
    if (serialized === lastSavedRef.current) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      lastSavedRef.current = serialized;
      void saveDashboardConfig(supabase, userId, payload);
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [supabase, userId, trackedTles, config]);

  return null;
}
