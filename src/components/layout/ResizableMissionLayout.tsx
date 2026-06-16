"use client";

import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { GripHorizontal, GripVertical, Maximize2, X } from 'lucide-react';

interface ResizableMissionLayoutProps {
  left: ReactNode;
  center: ReactNode;
  rightTop: ReactNode;
  rightBottom: ReactNode;
  diagnostics: ReactNode;
}

interface MissionLayoutSizing {
  leftWidth: number;
  rightWidth: number;
  /** Share of the right column's height given to its top widget, as a percentage. */
  rightTopRatio: number;
  diagnosticsHeightVh: number;
}

type ResizeTarget = 'left' | 'right' | 'rightSplit' | 'diagnostics';

const STORAGE_KEY = 'heliosat.missionLayoutSizing.v1';

const DEFAULT_SIZING: MissionLayoutSizing = {
  leftWidth: 360,
  rightWidth: 370,
  rightTopRatio: 58,
  diagnosticsHeightVh: 42,
};

const LIMITS = {
  leftWidth: { min: 320, max: 430 },
  rightWidth: { min: 320, max: 450 },
  rightTopRatio: { min: 28, max: 78 },
  diagnosticsHeightVh: { min: 30, max: 56 },
} as const;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const sanitizeSizing = (value: Partial<MissionLayoutSizing>): MissionLayoutSizing => ({
  leftWidth: clamp(Number(value.leftWidth) || DEFAULT_SIZING.leftWidth, LIMITS.leftWidth.min, LIMITS.leftWidth.max),
  rightWidth: clamp(Number(value.rightWidth) || DEFAULT_SIZING.rightWidth, LIMITS.rightWidth.min, LIMITS.rightWidth.max),
  rightTopRatio: clamp(
    Number(value.rightTopRatio) || DEFAULT_SIZING.rightTopRatio,
    LIMITS.rightTopRatio.min,
    LIMITS.rightTopRatio.max,
  ),
  diagnosticsHeightVh: clamp(
    Number(value.diagnosticsHeightVh) || DEFAULT_SIZING.diagnosticsHeightVh,
    LIMITS.diagnosticsHeightVh.min,
    LIMITS.diagnosticsHeightVh.max,
  ),
});

const readStoredSizing = (): MissionLayoutSizing | null => {
  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY);

    if (!rawValue) {
      return null;
    }

    return sanitizeSizing(JSON.parse(rawValue) as Partial<MissionLayoutSizing>);
  } catch {
    return null;
  }
};

const writeStoredSizing = (sizing: MissionLayoutSizing) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sizing));
  } catch {
    // Resizing still works for the current session when localStorage is unavailable.
  }
};

export const ResizableMissionLayout: React.FC<ResizableMissionLayoutProps> = ({
  left,
  center,
  rightTop,
  rightBottom,
  diagnostics,
}) => {
  const [sizing, setSizing] = useState<MissionLayoutSizing>(DEFAULT_SIZING);
  const [hasLoadedStoredSizing, setHasLoadedStoredSizing] = useState(false);
  const [activeResizeTarget, setActiveResizeTarget] = useState<ResizeTarget | null>(null);
  const rightTopRef = useRef<HTMLDivElement>(null);
  const rightBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      const storedSizing = readStoredSizing();

      if (storedSizing) {
        setSizing(storedSizing);
      }

      setHasLoadedStoredSizing(true);
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  useEffect(() => {
    if (!hasLoadedStoredSizing) {
      return;
    }

    writeStoredSizing(sizing);
  }, [hasLoadedStoredSizing, sizing]);

  const layoutStyle = useMemo(() => ({
    '--mission-grid-columns': `${sizing.leftWidth}px minmax(0, 1fr) ${sizing.rightWidth}px`,
  }) as CSSProperties, [sizing.leftWidth, sizing.rightWidth]);

  const rightColumnStyle = useMemo(() => ({
    // The two right-column widgets fill the available height in this ratio (top : bottom),
    // so the boundary between them is what the split handle drags.
    '--right-top-grow': `${sizing.rightTopRatio}`,
    '--right-bottom-grow': `${100 - sizing.rightTopRatio}`,
  }) as CSSProperties, [sizing.rightTopRatio]);

  const diagnosticsStyle = useMemo(() => ({
    maxHeight: `${sizing.diagnosticsHeightVh}vh`,
  }), [sizing.diagnosticsHeightVh]);

  const beginColumnResize = useCallback((target: 'left' | 'right', event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = target === 'left' ? sizing.leftWidth : sizing.rightWidth;
    const limits = target === 'left' ? LIMITS.leftWidth : LIMITS.rightWidth;
    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    setActiveResizeTarget(target);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const nextWidth = target === 'left' ? startWidth + deltaX : startWidth - deltaX;

      setSizing(current => ({
        ...current,
        [`${target}Width`]: clamp(Math.round(nextWidth), limits.min, limits.max),
      }));
    };

    const stopResize = () => {
      setActiveResizeTarget(null);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, [sizing.leftWidth, sizing.rightWidth]);

  const beginDiagnosticsResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();

    const startY = event.clientY;
    const startHeight = sizing.diagnosticsHeightVh;
    const viewportHeight = Math.max(window.innerHeight, 1);
    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    setActiveResizeTarget('diagnostics');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaVh = ((startY - moveEvent.clientY) / viewportHeight) * 100;

      setSizing(current => ({
        ...current,
        diagnosticsHeightVh: clamp(
          Math.round((startHeight + deltaVh) * 10) / 10,
          LIMITS.diagnosticsHeightVh.min,
          LIMITS.diagnosticsHeightVh.max,
        ),
      }));
    };

    const stopResize = () => {
      setActiveResizeTarget(null);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, [sizing.diagnosticsHeightVh]);

  const beginRightSplitResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();

    // Drag is measured against the live span of the two stacked widgets, so the boundary
    // tracks the pointer regardless of the column header above them.
    const topRect = rightTopRef.current?.getBoundingClientRect();
    const bottomRect = rightBottomRef.current?.getBoundingClientRect();

    if (!topRect || !bottomRect) {
      return;
    }

    const regionTop = topRect.top;
    const regionHeight = Math.max(bottomRect.bottom - topRect.top, 1);
    const originalCursor = document.body.style.cursor;
    const originalUserSelect = document.body.style.userSelect;

    setActiveResizeTarget('rightSplit');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const ratio = ((moveEvent.clientY - regionTop) / regionHeight) * 100;

      setSizing(current => ({
        ...current,
        rightTopRatio: clamp(Math.round(ratio), LIMITS.rightTopRatio.min, LIMITS.rightTopRatio.max),
      }));
    };

    const stopResize = () => {
      setActiveResizeTarget(null);
      document.body.style.cursor = originalCursor;
      document.body.style.userSelect = originalUserSelect;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, []);

  const nudgeRightSplit = useCallback((amount: number) => {
    setSizing(current => ({
      ...current,
      rightTopRatio: clamp(current.rightTopRatio + amount, LIMITS.rightTopRatio.min, LIMITS.rightTopRatio.max),
    }));
  }, []);

  const nudgeColumn = useCallback((target: 'left' | 'right', amount: number) => {
    const limits = target === 'left' ? LIMITS.leftWidth : LIMITS.rightWidth;

    setSizing(current => {
      const key = `${target}Width` as const;

      return {
        ...current,
        [key]: clamp(current[key] + amount, limits.min, limits.max),
      };
    });
  }, []);

  const nudgeDiagnostics = useCallback((amount: number) => {
    setSizing(current => ({
      ...current,
      diagnosticsHeightVh: clamp(
        Math.round((current.diagnosticsHeightVh + amount) * 10) / 10,
        LIMITS.diagnosticsHeightVh.min,
        LIMITS.diagnosticsHeightVh.max,
      ),
    }));
  }, []);

  return (
    <>
      <div
        className="grid min-h-0 grid-cols-1 gap-3 lg:grid-cols-[340px_minmax(0,1fr)] xl:min-h-0 xl:flex-1 xl:[grid-template-columns:var(--mission-grid-columns)]"
        style={layoutStyle}
      >
        <aside className="relative min-h-0 min-w-0 xl:h-full">
          <div className="flex min-h-0 flex-col gap-2 xl:h-full xl:overflow-y-auto xl:pr-1">
            <div className="hidden shrink-0 px-1 font-mono text-[9px] uppercase tracking-[0.25em] text-cyan-300/60 xl:block">Ahora · L1</div>
            {left}
          </div>
          <ColumnResizeHandle
            active={activeResizeTarget === 'left'}
            edge="right"
            label="Ajustar anchura de Ahora L1"
            title="Arrastra para ampliar o comprimir Ahora L1"
            onPointerDown={event => beginColumnResize('left', event)}
            onDoubleClick={() => setSizing(current => ({ ...current, leftWidth: DEFAULT_SIZING.leftWidth }))}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                nudgeColumn('left', event.shiftKey ? -20 : -10);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                nudgeColumn('left', event.shiftKey ? 20 : 10);
              } else if (event.key === 'Home') {
                event.preventDefault();
                setSizing(current => ({ ...current, leftWidth: LIMITS.leftWidth.min }));
              } else if (event.key === 'End') {
                event.preventDefault();
                setSizing(current => ({ ...current, leftWidth: LIMITS.leftWidth.max }));
              }
            }}
          />
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col gap-2 xl:h-full xl:overflow-hidden">
          <div className="hidden shrink-0 px-1 font-mono text-[9px] uppercase tracking-[0.25em] text-cyan-300/60 xl:block">Situación</div>
          {center}
        </section>

        <aside className="relative min-h-0 min-w-0 lg:col-span-2 xl:col-span-1 xl:h-full">
          <ColumnResizeHandle
            active={activeResizeTarget === 'right'}
            edge="left"
            label="Ajustar anchura de Pronóstico e Impacto"
            title="Arrastra para ampliar o comprimir Pronóstico e Impacto"
            onPointerDown={event => beginColumnResize('right', event)}
            onDoubleClick={() => setSizing(current => ({ ...current, rightWidth: DEFAULT_SIZING.rightWidth }))}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                nudgeColumn('right', event.shiftKey ? 20 : 10);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                nudgeColumn('right', event.shiftKey ? -20 : -10);
              } else if (event.key === 'Home') {
                event.preventDefault();
                setSizing(current => ({ ...current, rightWidth: LIMITS.rightWidth.min }));
              } else if (event.key === 'End') {
                event.preventDefault();
                setSizing(current => ({ ...current, rightWidth: LIMITS.rightWidth.max }));
              }
            }}
          />
          <div
            className="flex min-h-0 flex-col gap-2 lg:grid lg:grid-cols-2 lg:gap-3 xl:flex xl:h-full xl:flex-col xl:overflow-hidden xl:pr-1"
            style={rightColumnStyle}
          >
            <div className="hidden shrink-0 px-1 font-mono text-[9px] uppercase tracking-[0.25em] text-cyan-300/60 lg:col-span-2 xl:block">Pronóstico · Impacto</div>

            <div ref={rightTopRef} className="min-h-0 xl:[flex-basis:0px] xl:[flex-grow:var(--right-top-grow)]">
              {rightTop}
            </div>

            <RightSplitHandle
              active={activeResizeTarget === 'rightSplit'}
              onPointerDown={beginRightSplitResize}
              onDoubleClick={() => setSizing(current => ({ ...current, rightTopRatio: DEFAULT_SIZING.rightTopRatio }))}
              onKeyDown={event => {
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  nudgeRightSplit(event.shiftKey ? -6 : -3);
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  nudgeRightSplit(event.shiftKey ? 6 : 3);
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  setSizing(current => ({ ...current, rightTopRatio: LIMITS.rightTopRatio.min }));
                } else if (event.key === 'End') {
                  event.preventDefault();
                  setSizing(current => ({ ...current, rightTopRatio: LIMITS.rightTopRatio.max }));
                }
              }}
            />

            <div ref={rightBottomRef} className="min-h-0 xl:[flex-basis:0px] xl:[flex-grow:var(--right-bottom-grow)]">
              {rightBottom}
            </div>
          </div>
        </aside>
      </div>

      <details className="shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/40">
        <summary className="cursor-pointer px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-slate-400 marker:text-slate-600 hover:text-slate-200">
          Diagnóstico · disponibilidad de datos · supuestos del modelo
        </summary>
        <div className="relative border-t border-slate-800">
          <button
            type="button"
            aria-label="Ajustar altura del diagnóstico"
            title="Arrastra para ampliar o comprimir el diagnóstico"
            onPointerDown={beginDiagnosticsResize}
            onDoubleClick={() => setSizing(current => ({ ...current, diagnosticsHeightVh: DEFAULT_SIZING.diagnosticsHeightVh }))}
            onKeyDown={event => {
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                nudgeDiagnostics(event.shiftKey ? 4 : 2);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                nudgeDiagnostics(event.shiftKey ? -4 : -2);
              } else if (event.key === 'Home') {
                event.preventDefault();
                setSizing(current => ({ ...current, diagnosticsHeightVh: LIMITS.diagnosticsHeightVh.min }));
              } else if (event.key === 'End') {
                event.preventDefault();
                setSizing(current => ({ ...current, diagnosticsHeightVh: LIMITS.diagnosticsHeightVh.max }));
              }
            }}
            className={`absolute left-1/2 top-0 z-20 hidden h-4 w-20 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded border bg-slate-950/95 outline-none transition xl:flex ${
              activeResizeTarget === 'diagnostics'
                ? 'border-cyan-300/70 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.22)]'
                : 'border-slate-700/80 text-slate-500 hover:border-cyan-400/50 hover:text-cyan-200 focus-visible:border-cyan-300/70 focus-visible:text-cyan-100'
            }`}
          >
            <GripHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <div
            className="grid gap-3 overflow-y-auto p-3 md:grid-cols-2"
            style={diagnosticsStyle}
          >
            {diagnostics}
          </div>
        </div>
      </details>
    </>
  );
};

export function ExpandableMissionWidget({
  title,
  children,
  detail,
  className = '',
}: {
  title: string;
  children: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const originalOverflow = document.body.style.overflow;
    const focusFrame = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = originalOverflow;
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`group/widget relative min-h-0 ${className}`}>
      {children}
      <button
        type="button"
        aria-label={`Ampliar ${title}`}
        title={`Ampliar ${title}`}
        onClick={() => setOpen(true)}
        className="absolute right-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-md border border-slate-700/80 bg-slate-950/90 text-slate-400 shadow-lg outline-none transition hover:border-cyan-400/50 hover:bg-cyan-400/10 hover:text-cyan-100 focus-visible:border-cyan-300/70 focus-visible:text-cyan-100"
      >
        <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm sm:p-5"
          onPointerDown={event => {
            if (event.target === event.currentTarget) {
              setOpen(false);
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="flex h-[min(860px,calc(100vh-2rem))] w-[min(1180px,calc(100vw-2rem))] min-w-0 flex-col overflow-hidden rounded-lg border border-slate-700/80 bg-[#020617] shadow-2xl"
          >
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/80 px-4 py-3">
              <h2 id={titleId} className="min-w-0 truncate font-mono text-[11px] font-semibold uppercase tracking-widest text-slate-300">
                {title}
              </h2>
              <button
                ref={closeButtonRef}
                type="button"
                aria-label={`Cerrar ${title}`}
                title="Cerrar"
                onClick={() => setOpen(false)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-slate-700 bg-slate-950/70 text-slate-400 outline-none transition hover:border-cyan-400/50 hover:bg-cyan-400/10 hover:text-cyan-100 focus-visible:border-cyan-300/70 focus-visible:text-cyan-100"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
              <div className="h-full min-h-[520px]">
                {detail ?? children}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ColumnResizeHandle({
  active,
  edge,
  label,
  title,
  onPointerDown,
  onDoubleClick,
  onKeyDown,
}: {
  active: boolean;
  edge: 'left' | 'right';
  label: string;
  title: string;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${title}. Doble clic para restablecer.`}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className={`absolute top-7 bottom-1 z-30 hidden w-4 touch-none cursor-col-resize items-center justify-center rounded outline-none transition xl:flex ${
        edge === 'right' ? '-right-2' : '-left-2'
      } ${
        active
          ? 'text-cyan-100'
          : 'text-slate-600 hover:text-cyan-200 focus-visible:text-cyan-100'
      }`}
    >
      <span className={`h-full w-px rounded-full transition ${active ? 'bg-cyan-300/80' : 'bg-slate-700/70'}`} />
      <GripVertical className="absolute h-4 w-4 rounded bg-slate-950/95" aria-hidden="true" />
    </button>
  );
}

function RightSplitHandle({
  active,
  onPointerDown,
  onDoubleClick,
  onKeyDown,
}: {
  active: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      aria-label="Ajustar reparto entre Satellite Operator Report y Selected Satellite"
      title="Arrastra para dar más espacio a un panel u otro. Doble clic para restablecer."
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className={`relative z-30 hidden h-3 w-full shrink-0 touch-none cursor-row-resize items-center justify-center rounded outline-none transition xl:flex ${
        active ? 'text-cyan-100' : 'text-slate-600 hover:text-cyan-200 focus-visible:text-cyan-100'
      }`}
    >
      <span className={`h-px w-full rounded-full transition ${active ? 'bg-cyan-300/80' : 'bg-slate-700/70'}`} />
      <GripHorizontal className="absolute h-4 w-7 rounded bg-slate-950/95" aria-hidden="true" />
    </button>
  );
}
