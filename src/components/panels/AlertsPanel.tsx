import React from 'react';
import { GlassCard } from '../ui/GlassCard';
import type { NoaaAlertsResponse } from '@/services/noaaAlertsService';

interface AlertsPanelProps {
  noaaAlertsData: NoaaAlertsResponse;
  compact?: boolean;
}

export const AlertsPanel: React.FC<AlertsPanelProps> = ({ noaaAlertsData, compact = false }) => {
  const { alerts, errorMessage } = noaaAlertsData;
  return (
    <GlassCard
      title="NOAA Alerts"
      className="h-full"
      bodyClassName={compact ? 'p-3' : 'p-4'}
      headerClassName={compact ? 'px-3 py-2' : undefined}
    >
      <div className={`${compact ? 'space-y-3' : 'space-y-4'} h-full overflow-y-auto pr-2`}>
        {errorMessage && (
          <div className={`${compact ? 'text-[10px]' : 'text-sm'} mb-4 rounded border border-red-900/50 bg-red-900/20 px-3 py-2 font-mono text-red-400`}>
            {errorMessage}
          </div>
        )}

        {alerts && alerts.length > 0 ? (
          alerts.map((alert, index) => (
            <div key={index} className={`flex flex-col gap-2 rounded border border-slate-700/50 bg-slate-800/30 ${compact ? 'p-2.5' : 'p-3'}`}>
              <div className="flex justify-between items-center border-b border-slate-700/50 pb-2">
                <span className={`${compact ? 'text-[10px]' : 'text-xs'} font-mono font-bold text-slate-300`}>
                  Product ID: {alert.product_id ?? <span className="text-slate-600">Not available</span>}
                </span>
                <span className={`${compact ? 'text-[10px]' : 'text-xs'} font-mono text-slate-500`}>
                  {alert.issue_datetime ?? 'Not available'}
                </span>
              </div>
              <pre className={`${compact ? 'text-[10px] leading-snug' : 'text-xs leading-relaxed'} whitespace-pre-wrap font-sans text-slate-400`}>
                {alert.message ?? <span className="text-slate-600 italic">No message content available</span>}
              </pre>
            </div>
          ))
        ) : (
          !errorMessage && (
            <div className="flex items-center justify-center h-full text-slate-500 font-mono text-sm uppercase tracking-wider">
              No alerts returned by NOAA
            </div>
          )
        )}
      </div>
    </GlassCard>
  );
};
