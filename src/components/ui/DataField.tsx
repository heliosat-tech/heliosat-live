import React from 'react';

interface DataFieldProps {
  label: string;
  value?: string | number | null;
  unit?: string;
  className?: string;
}

export const DataField: React.FC<DataFieldProps> = ({ label, value, unit, className = '' }) => {
  const isAvailable = value !== undefined && value !== null && value !== 'Not available';
  
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">
        {label}
      </span>
      <div className="flex items-baseline gap-1 font-mono">
        <span className={`text-lg ${isAvailable ? 'text-slate-100' : 'text-slate-600'}`}>
          {isAvailable ? value : 'Not available'}
        </span>
        {isAvailable && unit && (
          <span className="text-xs text-slate-500">{unit}</span>
        )}
      </div>
    </div>
  );
};
