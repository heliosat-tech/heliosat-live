import React from 'react';
import { Activity, XCircle } from 'lucide-react';

interface SourceStatusBadgeProps {
  sourceName: string;
  isConnected: boolean;
  isPartial?: boolean;
}

export const SourceStatusBadge: React.FC<SourceStatusBadgeProps> = ({ sourceName, isConnected, isPartial }) => {
  return (
    <div className="flex items-center gap-2 text-xs border border-slate-700/50 rounded-full px-3 py-1 bg-slate-800/20">
      {isConnected ? (
        <Activity className={`w-3 h-3 ${isPartial ? 'text-amber-400' : 'text-cyan-400'}`} />
      ) : (
        <XCircle className="w-3 h-3 text-red-500/70" />
      )}
      <span className={isConnected ? (isPartial ? 'text-amber-300' : 'text-slate-300') : 'text-slate-500'}>
        {sourceName}: {isConnected ? (isPartial ? 'Partial' : 'Connected') : 'Source not connected'}
      </span>
    </div>
  );
};
