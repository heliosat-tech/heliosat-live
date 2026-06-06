"use client";

import React, { useEffect, useState } from 'react';
import { AdminIndicator } from '../auth/AdminIndicator';
import { AuthControls } from '../auth/AuthControls';
import { SourceStatusBadge } from '../ui/SourceStatusBadge';

interface TopStatusBarProps {
  noaaMagConnected: boolean;
  noaaMagLastUpdated: string | null;
  noaaMagPartial?: boolean;
  noaaAlertsConnected: boolean;
  noaaAlertsLastUpdated: string | null;
  celesTrakConnected: boolean;
  celesTrakLastUpdated: string | null;
}

export const TopStatusBar: React.FC<TopStatusBarProps> = ({ 
  noaaMagConnected, 
  noaaMagLastUpdated, 
  noaaMagPartial,
  noaaAlertsConnected,
  noaaAlertsLastUpdated,
  celesTrakConnected,
  celesTrakLastUpdated
}) => {
  const [time, setTime] = useState<string>("Not available");

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTime(now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC');
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="sticky top-3 z-[100] flex shrink-0 items-center justify-between gap-4 overflow-visible rounded-lg border border-slate-700/50 bg-slate-900/75 px-4 py-3 shadow-lg backdrop-blur-md xl:top-0 xl:px-6">
      <div className="flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse flex-shrink-0"></span>
        {/* HelioSat logo — mix-blend-multiply inverts the white background against the dark shell */}
        <img
          src="/heliosat-logo.jpeg"
          alt="HelioSat Technologies"
          className="h-9 w-auto object-contain"
          style={{ mixBlendMode: 'lighten', filter: 'brightness(1.05) contrast(1.1)' }}
        />
        <span className="text-[10px] font-mono tracking-[0.25em] text-slate-400 uppercase border-l border-slate-700 pl-3 ml-1">
          Mission Control
        </span>
      </div>
      
      <div className="flex min-w-0 items-center gap-3 text-sm xl:gap-4">
        <div className="flex min-w-0 items-center gap-4 overflow-x-auto py-1 xl:gap-6">
          <div className="font-mono text-cyan-300 tracking-wider">
            {time}
          </div>
          <div className="h-4 w-px bg-slate-700"></div>
          <div className="flex items-center gap-4">
            {noaaMagLastUpdated && (
              <div className="text-xs text-slate-500 mr-2">
                NOAA Solar Wind Update: {new Date(noaaMagLastUpdated).toLocaleTimeString('en-US', { timeZone: 'UTC' })} UTC
              </div>
            )}
            <SourceStatusBadge sourceName="NOAA Solar Wind" isConnected={noaaMagConnected} isPartial={noaaMagPartial} />
            
            <div className="h-4 w-px bg-slate-700 mx-2"></div>
            
            {noaaAlertsLastUpdated && (
              <div className="text-xs text-slate-500 mr-2">
                Alerts Update: {new Date(noaaAlertsLastUpdated).toLocaleTimeString('en-US', { timeZone: 'UTC' })} UTC
              </div>
            )}
            <SourceStatusBadge sourceName="NOAA Alerts" isConnected={noaaAlertsConnected} />
            
            <div className="h-4 w-px bg-slate-700 mx-2"></div>
            
            {celesTrakLastUpdated && (
              <div className="text-xs text-slate-500 mr-2">
                CelesTrak Update: {new Date(celesTrakLastUpdated).toLocaleTimeString('en-US', { timeZone: 'UTC' })} UTC
              </div>
            )}
            <SourceStatusBadge sourceName="CelesTrak" isConnected={celesTrakConnected} />
          </div>
        </div>

        <div className="relative z-[110] flex shrink-0 items-center gap-3 border-l border-slate-700 pl-3">
          <AdminIndicator />
          <AuthControls />
        </div>
      </div>
    </header>
  );
};
