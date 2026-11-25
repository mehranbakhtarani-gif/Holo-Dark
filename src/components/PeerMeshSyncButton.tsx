import React from 'react';
import { Network, RefreshCw } from 'lucide-react';
import { toPersianDigits } from '../lib/format';

export interface PeerMeshSyncButtonProps {
  variant?: 'header' | 'action';
  isMeshActive: boolean;
  isSyncing: boolean;
  connectedPeerCount?: number;
  isConfigured?: boolean;
  label?: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}

/**
 * Dedicated PeerJS Mesh Sync Button with a subtle primary-theme pulse wave
 * indicating live mesh connectivity or active version-vector synchronization.
 */
export const PeerMeshSyncButton: React.FC<PeerMeshSyncButtonProps> = ({
  variant = 'action',
  isMeshActive,
  isSyncing,
  connectedPeerCount = 0,
  isConfigured = true,
  label,
  title,
  disabled = false,
  onClick,
  className = '',
}) => {
  const showWave = isSyncing || isMeshActive;
  const waveClass = isSyncing
    ? 'apex-mesh-pulse-wave-fast'
    : isMeshActive
      ? 'apex-mesh-pulse-wave'
      : '';

  if (variant === 'header') {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={
          title ||
          'وضعیت همگام‌سازی مستقیم P2P بین ۳ دستگاه (کلیک برای مشاهده گزارش همگام‌سازی PeerJS)'
        }
        className={`relative inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
          isSyncing || connectedPeerCount > 0
            ? 'border-teal-400/80 dark:border-teal-500/70 bg-teal-50/90 dark:bg-teal-950/50 text-teal-800 dark:text-teal-200 hover:bg-teal-100/80'
            : isMeshActive
              ? 'border-teal-300/70 dark:border-teal-700/70 bg-teal-50/40 dark:bg-teal-950/25 text-teal-800 dark:text-teal-300 hover:bg-teal-50 dark:hover:bg-teal-950/40'
              : 'border-slate-200 dark:border-white/10 dark:bg-white/[0.03] text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-white/[0.08]'
        } ${waveClass} ${className}`}
      >
        <span className="relative flex items-center justify-center shrink-0">
          {showWave && (
            <span
              aria-hidden="true"
              className={`absolute -inset-1 rounded-full bg-teal-500/25 dark:bg-teal-400/25 ${
                isSyncing ? 'animate-ping' : 'animate-pulse'
              }`}
            />
          )}
          <Network
            className={`relative w-3.5 h-3.5 shrink-0 ${
              isSyncing
                ? 'text-teal-700 dark:text-teal-300'
                : isMeshActive
                  ? 'text-teal-600 dark:text-teal-400'
                  : ''
            }`}
          />
        </span>

        <span className="font-code">
          {label ??
            `P2P ${isConfigured ? `${toPersianDigits(connectedPeerCount)}/۲` : 'راه‌اندازی'}`}
        </span>

        {showWave && (
          <span
            aria-hidden="true"
            className="relative flex h-2 w-2 shrink-0"
          >
            <span
              className={`absolute inline-flex h-full w-full rounded-full bg-teal-500 dark:bg-teal-400 opacity-75 ${
                isSyncing ? 'animate-ping' : 'animate-pulse'
              }`}
            />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-600 dark:bg-teal-400" />
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || isSyncing}
      title={title}
      className={`relative inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition-colors disabled:opacity-65 whitespace-nowrap ${waveClass} ${className}`}
    >
      {showWave && (
        <span
          aria-hidden="true"
          className="relative flex h-2 w-2 shrink-0"
        >
          <span
            className={`absolute inline-flex h-full w-full rounded-full bg-teal-200 opacity-80 ${
              isSyncing ? 'animate-ping' : 'animate-pulse'
            }`}
          />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-100" />
        </span>
      )}
      {isSyncing ? (
        <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
      ) : (
        <Network className="w-3.5 h-3.5 shrink-0" />
      )}
      <span>{label || 'همگام‌سازی فوری P2P'}</span>
    </button>
  );
};
