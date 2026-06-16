"use client";

import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import type { NoaaServiceResponse, NoaaMagnetometerData, NoaaPlasmaData } from '@/services/noaaSolarWindService';

interface SolarWindChartsPanelProps {
  noaaMagData: NoaaServiceResponse<NoaaMagnetometerData>;
  noaaPlasmaData: NoaaServiceResponse<NoaaPlasmaData>;
}

type SolarWindChartRow = NoaaMagnetometerData | NoaaPlasmaData;
type SolarWindChartKey = keyof NoaaMagnetometerData | keyof NoaaPlasmaData;

interface ChartProps {
  data: SolarWindChartRow[];
  dataKey: SolarWindChartKey;
  name: string;
  unit: string;
  color: string;
  hasData: boolean;
}

function parseChartValue(row: SolarWindChartRow, dataKey: SolarWindChartKey) {
  if (!(dataKey in row)) {
    return null;
  }

  const rawValue = row[dataKey as keyof SolarWindChartRow];

  if (rawValue === null || rawValue === undefined) {
    return null;
  }

  const parsedValue = Number(rawValue);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

function formatYAxisTick(value: number | string, dataKey: SolarWindChartKey) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return '';
  }

  if (dataKey === 'temperature') {
    const absoluteValue = Math.abs(numericValue);

    if (absoluteValue >= 1_000_000) {
      return `${(numericValue / 1_000_000).toFixed(1)}M`;
    }

    if (absoluteValue >= 1_000) {
      return `${Math.round(numericValue / 1_000)}k`;
    }

    return numericValue.toFixed(0);
  }

  return numericValue.toFixed(1);
}

const SimpleLineChart: React.FC<ChartProps> = ({ data, dataKey, name, unit, color, hasData }) => {
  if (!hasData || data.length === 0) {
    return (
      <div className="h-32 w-full flex items-center justify-center border border-slate-800 rounded bg-slate-900/20 mb-6">
        <span className="text-xs font-mono text-slate-500 uppercase tracking-widest">
          No data available for this chart
        </span>
      </div>
    );
  }

  // Parse values to float for charting, keep time_tag as is
  const parsedData = data.map(d => {
    const value = parseChartValue(d, dataKey);

    return {
      ...d,
      timeShort: d.time_tag ? new Date(d.time_tag).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '',
      [dataKey]: value
    };
  });
  const isTemperatureChart = dataKey === 'temperature';

  return (
    <div className="mb-6">
      <div className="flex justify-between items-center mb-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{name}</h4>
        <span className="text-[10px] text-slate-500 font-mono">{unit}</span>
      </div>
      <div className="h-32 min-h-[128px] w-full">
        <ResponsiveContainer
          width="100%"
          height={128}
          minWidth={0}
          minHeight={128}
          initialDimension={{ width: 320, height: 128 }}
        >
          <LineChart data={parsedData} margin={{ top: 5, right: 5, left: isTemperatureChart ? 4 : -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
            <XAxis 
              dataKey="timeShort" 
              stroke="#475569" 
              fontSize={10} 
              tickMargin={5}
              minTickGap={20}
            />
            <YAxis 
              stroke="#475569" 
              fontSize={10} 
              width={isTemperatureChart ? 48 : 40}
              tickMargin={4}
              tickFormatter={(val: number | string) => formatYAxisTick(val, dataKey)}
              domain={['auto', 'auto']}
            />
            <Tooltip 
              contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '4px', fontSize: '12px' }}
              itemStyle={{ color: color }}
              labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
            />
            <Line 
              type="linear" 
              dataKey={dataKey} 
              stroke={color} 
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export const SolarWindChartsPanel: React.FC<SolarWindChartsPanelProps> = ({ noaaMagData, noaaPlasmaData }) => {
  return (
    <div className="flex flex-col mt-6 border-t border-slate-700/50 pt-6">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-cyan-500/70 mb-4 pb-1 border-b border-slate-700/50">
        Telemetry Time-Series (2H)
      </h3>
      
      <SimpleLineChart 
        data={noaaMagData.timeSeries} 
        dataKey="bz_gsm" 
        name="Bz GSM" 
        unit="nT" 
        color="#38bdf8" 
        hasData={noaaMagData.isConnected} 
      />
      
      <SimpleLineChart 
        data={noaaMagData.timeSeries} 
        dataKey="bt" 
        name="Bt" 
        unit="nT" 
        color="#818cf8" 
        hasData={noaaMagData.isConnected} 
      />
      
      <SimpleLineChart 
        data={noaaPlasmaData.timeSeries} 
        dataKey="speed" 
        name="Solar Wind Speed" 
        unit="km/s" 
        color="#f472b6" 
        hasData={noaaPlasmaData.isConnected} 
      />
      
      <SimpleLineChart 
        data={noaaPlasmaData.timeSeries} 
        dataKey="density" 
        name="Proton Density" 
        unit="cm⁻³" 
        color="#34d399" 
        hasData={noaaPlasmaData.isConnected} 
      />
      
      <SimpleLineChart 
        data={noaaPlasmaData.timeSeries} 
        dataKey="temperature" 
        name="Proton Temperature" 
        unit="K" 
        color="#fbbf24" 
        hasData={noaaPlasmaData.isConnected} 
      />
    </div>
  );
};
