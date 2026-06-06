import React from 'react';

interface AppShellProps {
  children: React.ReactNode;
}

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  return (
    <div className="min-h-screen overflow-y-auto overflow-x-hidden bg-[#020617] text-slate-200 selection:bg-cyan-500/30 font-sans xl:h-screen xl:overflow-hidden">
      <div className="fixed inset-0 z-[-1] bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-900/10 via-[#020617] to-[#020617] pointer-events-none"></div>
      <div className="flex min-h-screen flex-col gap-3 p-3 xl:h-screen xl:min-h-0">
        {children}
      </div>
    </div>
  );
};
