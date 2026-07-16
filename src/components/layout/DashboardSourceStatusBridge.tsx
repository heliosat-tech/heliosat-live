"use client";

import { useMemo } from 'react';
import { useSatelliteConfig } from '@/contexts/SatelliteConfigContext';
import { TopStatusBar } from './TopStatusBar';
import { buildCelestrakSourceStatus, type SourceStatus } from './sourceStatus';

interface DashboardSourceStatusBridgeProps {
  sources: SourceStatus[];
}

/** Reconciles the server snapshot with the one client-side TLE fetch already owned by the provider. */
export function DashboardSourceStatusBridge({ sources }: DashboardSourceStatusBridgeProps) {
  const { tleData, tleLoading } = useSatelliteConfig();
  const reconciledSources = useMemo(
    () => [...sources, buildCelestrakSourceStatus(tleData, tleLoading)],
    [sources, tleData, tleLoading],
  );

  return <TopStatusBar sources={reconciledSources} />;
}
