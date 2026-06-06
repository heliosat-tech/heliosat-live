import React from 'react';

interface GlassCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  headerClassName?: string;
}

export const GlassCard: React.FC<GlassCardProps> = ({
  title,
  children,
  className = '',
  bodyClassName = 'p-4',
  headerClassName = '',
}) => {
  return (
    <div className={`flex min-h-0 flex-col bg-slate-900/30 backdrop-blur-xl border border-slate-700/50 rounded-lg overflow-hidden shadow-2xl ${className}`}>
      <div className={`px-4 py-2 border-b border-slate-700/50 bg-slate-800/30 flex shrink-0 items-center ${headerClassName}`}>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">{title}</h2>
      </div>
      <div className={`min-h-0 flex-1 overflow-auto ${bodyClassName}`}>
        {children}
      </div>
    </div>
  );
};
