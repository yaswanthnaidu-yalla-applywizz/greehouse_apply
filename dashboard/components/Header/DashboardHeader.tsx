import React from 'react';
import type { DashboardStats } from '../../types.js';
import { DevSwitcher } from '../DevSwitcher.js';
import { HeaderSignOut } from '../HeaderSignOut.js';

export interface NotificationItem {
  id: string;
  status?: string;
  type?: string;
  timestamp?: number | string;
  applywizzId?: string;
  jobUrl?: string;
  candidateName?: string;
  companyName?: string;
  jobTitle?: string;
  reason?: string;
  proofWebUrl?: string;
  proofFailedUrl?: string;
}

export interface DashboardHeaderProps {
  activeTab: 'dashboard' | 'stats';
  setActiveTab: (tab: 'dashboard' | 'stats') => void;
  selectedDate: string;
  setSelectedDate: (date: string) => void;
  stats: DashboardStats | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  onSignOut: () => void;
  notifications: NotificationItem[];
  unreadNotifsCount: number;
  readNotifIds: Set<string>;
  isNotifOpen: boolean;
  setIsNotifOpen: React.Dispatch<React.SetStateAction<boolean>>;
  notifRef: React.RefObject<HTMLDivElement | null>;
  markAllNotifsAsRead: () => void;
  clearAllNotifs: () => void;
  clearNotification: (id: string) => void;
  onSelectNotification: (notif: NotificationItem) => void;
}

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  activeTab,
  setActiveTab,
  selectedDate,
  setSelectedDate,
  stats,
  isRefreshing,
  onRefresh,
  onSignOut,
  notifications,
  unreadNotifsCount,
  readNotifIds,
  isNotifOpen,
  setIsNotifOpen,
  notifRef,
  markAllNotifsAsRead,
  clearAllNotifs,
  clearNotification,
  onSelectNotification,
}) => {
  return (
    <header className="bg-[#0a0a0a] border-b border-[#2c2c2e] flex-shrink-0">
      <div className="flex flex-col">
        {/* Tier 1: Brand Logo, Tabs (Dashboard / Stats), Notification Bell, Sign Out */}
        <div
          data-testid="header-tier-1"
          className="h-14 px-4 sm:px-6 flex items-center justify-between border-b border-[#2c2c2e]/60"
        >
          {/* Left: Brand Logo + Navigation Tabs */}
          <div className="flex items-center gap-3 sm:gap-6 min-w-0">
            <div className="flex items-center gap-2.5 flex-shrink-0">
              <img
                src="/logo.webp"
                alt="ApplyWizz"
                className="w-7 h-7 sm:w-8 sm:h-8 max-w-[32px] max-h-[32px] rounded-lg border border-[#2c2c2e] object-cover bg-black flex-shrink-0"
                style={{ width: '32px', height: '32px' }}
              />
              <div>
                <span className="text-xs sm:text-sm font-bold tracking-tight text-[#ffffff] uppercase leading-none block">
                  ApplyWizz
                </span>
                <span className="text-[9px] sm:text-[10px] font-mono text-[#8e8e93] font-medium leading-none mt-0.5 block">
                  Auto Apply V2
                </span>
              </div>
            </div>

            {/* Navigation Tabs (Dashboard / Stats) beside the logo */}
            <nav className="flex items-center gap-1 bg-[#1c1c1e] border border-[#2c2c2e] rounded-lg p-1 flex-shrink-0">
              <button
                type="button"
                onClick={() => setActiveTab('dashboard')}
                className={`px-2.5 sm:px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                  activeTab === 'dashboard'
                    ? 'bg-[#2c2c2e] text-[#ffffff] border border-[#3a3a3c]'
                    : 'text-[#8e8e93] hover:text-[#ffffff] hover:bg-[#2c2c2e]/60'
                }`}
              >
                Dashboard
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('stats')}
                className={`px-2.5 sm:px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                  activeTab === 'stats'
                    ? 'bg-[#2c2c2e] text-[#ffffff] border border-[#3a3a3c]'
                    : 'text-[#8e8e93] hover:text-[#ffffff] hover:bg-[#2c2c2e]/60'
                }`}
              >
                Stats
              </button>
            </nav>
          </div>

          {/* Right: Notifications & User Avatar */}
          <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
            {/* Interactive Notification Bell & Dropdown */}
            <div className="relative" ref={notifRef as any}>
              <button
                type="button"
                onClick={() => setIsNotifOpen((prev) => !prev)}
                title="Notifications"
                className="relative p-1.5 bg-[#1c1c1e] border border-[#2c2c2e] rounded-md cursor-pointer hover:bg-[#2c2c2e] transition-colors"
              >
                <span className="text-xs">🔔</span>
                {unreadNotifsCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 bg-[#ff453a] text-white text-[10px] font-black rounded-full flex items-center justify-center border border-[#1c1c1e]">
                    {unreadNotifsCount > 9 ? '9+' : unreadNotifsCount}
                  </span>
                )}
              </button>

              {isNotifOpen && (
                <div className="absolute right-0 mt-2 w-80 sm:w-96 bg-[#1c1c1e] border border-[#2c2c2e] rounded-xl z-50 overflow-hidden animate-fadeIn shadow-2xl">
                  <div className="flex items-center justify-between px-3.5 py-2.5 bg-[#141416] border-b border-[#2c2c2e]">
                    <div className="flex items-center gap-2">
                      <span className="text-sm">🔔</span>
                      <span className="text-xs font-semibold uppercase tracking-wider text-[#ffffff]">
                        Notifications {unreadNotifsCount > 0 && `(${unreadNotifsCount} new)`}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {notifications.length > 0 && (
                        <button
                          type="button"
                          onClick={markAllNotifsAsRead}
                          className="text-[10px] font-semibold text-[#8e8e93] hover:text-[#ffffff] bg-[#2c2c2e] border border-[#3a3a3c] px-2 py-0.5 rounded-md"
                        >
                          Mark all read
                        </button>
                      )}
                      {notifications.length > 0 && (
                        <button
                          type="button"
                          onClick={clearAllNotifs}
                          className="text-[10px] font-semibold text-[#ff453a] hover:text-[#ffffff] bg-[#ff453a]/15 border border-[#ff453a]/30 px-2 py-0.5 rounded-md"
                        >
                          Clear
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setIsNotifOpen(false)}
                        className="text-[#8e8e93] hover:text-[#ffffff] text-xs font-bold px-1"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="max-h-80 overflow-y-auto p-2.5 space-y-2 custom-scrollbar">
                    {notifications.length === 0 ? (
                      <div className="p-6 text-center text-xs text-[#8e8e93]">
                        No notifications yet. Alerts for succeeded and failed applications will appear here.
                      </div>
                    ) : (
                      notifications.map((notif) => {
                        const isApplying = notif.status === 'APPLYING';
                        const isSuccess = notif.status === 'APPLIED' || notif.type === 'SUCCESS';
                        const isUnread = !readNotifIds.has(notif.id);
                        return (
                          <div
                            key={notif.id}
                            onClick={() => onSelectNotification(notif)}
                            className={`p-2.5 rounded-lg border cursor-pointer transition-all ${
                              isApplying
                                ? 'bg-[#2c2c2e] border-[#0a84ff]/40 hover:border-[#0a84ff]'
                                : isSuccess
                                ? 'bg-[#2c2c2e] border-[#30d158]/40 hover:border-[#30d158]'
                                : 'bg-[#2c2c2e] border-[#ff453a]/40 hover:border-[#ff453a]'
                            } ${isUnread ? 'border-l-4 border-l-[#0a84ff]' : 'opacity-85'}`}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span
                                className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                  isApplying
                                    ? 'bg-[#0a84ff]/15 text-[#0a84ff] border border-[#0a84ff]/30'
                                    : isSuccess
                                    ? 'bg-[#30d158]/15 text-[#30d158] border border-[#30d158]/30'
                                    : 'bg-[#ff453a]/15 text-[#ff453a] border border-[#ff453a]/30'
                                }`}
                              >
                                {isApplying ? '⏳ Applying' : isSuccess ? '✅ Succeeded' : '❌ Failed'}
                              </span>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-[#8e8e93] font-mono">
                                  {notif.timestamp ? new Date(notif.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    clearNotification(notif.id);
                                  }}
                                  title="Dismiss notification"
                                  className="text-[10px] text-[#8e8e93] hover:text-[#ff453a] px-1 py-0.5 rounded hover:bg-[#3a3a3c] font-bold transition-colors"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>

                            <div className="text-xs font-semibold text-[#ffffff]">
                              {notif.candidateName || notif.applywizzId}{' '}
                              <span className="font-mono text-[10px] text-[#8e8e93] font-normal">
                                ({notif.applywizzId})
                              </span>
                            </div>

                            <div className="text-[11px] text-[#8e8e93] font-medium truncate mt-0.5">
                              🏢 {notif.companyName} — {notif.jobTitle}
                            </div>

                            {isApplying && (
                              <div className="mt-1 text-[10px] text-[#0a84ff] font-mono flex items-center gap-1">
                                <span className="inline-block animate-spin">⏳</span> Application submission in progress...
                              </div>
                            )}

                            {!isSuccess && !isApplying && (
                              <div className="mt-1.5 p-1.5 bg-[#1c1c1e] border border-[#ff453a]/30 rounded text-[11px] text-[#ff453a] font-mono break-words leading-tight">
                                <span className="font-bold">Reason: </span>
                                {notif.reason || 'Submission failed or was rejected.'}
                              </div>
                            )}

                            {isSuccess && notif.proofWebUrl && (
                              <div className="mt-1.5 flex justify-end">
                                <a
                                  href={notif.proofWebUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-[10px] font-semibold text-[#30d158] underline hover:text-[#28b84d]"
                                >
                                  View Proof Screenshot ↗
                                </a>
                              </div>
                            )}

                            {!isSuccess && !isApplying && notif.proofFailedUrl && (
                              <div className="mt-1.5 flex justify-end">
                                <a
                                  href={notif.proofFailedUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-[10px] font-semibold text-[#ff453a] underline hover:text-[#ff453a]/80"
                                >
                                  View Failure Screenshot ↗
                                </a>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* User Profile Avatar & Sign Out */}
            <HeaderSignOut onSignOut={onSignOut} />
          </div>
        </div>

        {/* Tier 2: Date Scope Filter & Quick Controls */}
        <div
          data-testid="header-tier-2"
          className="py-2 px-4 sm:px-6 bg-[#141416] flex flex-wrap items-center justify-between gap-2 border-b border-[#2c2c2e]"
        >
          {/* Left in Tier 2: Date Scope Filter & Stats Totals */}
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 bg-[#1c1c1e] border border-[#2c2c2e] px-2.5 py-1 rounded-md flex-shrink-0">
              <span className="text-[11px] sm:text-xs font-mono font-medium text-[#8e8e93]">📅 IST:</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => {
                  if (e.target.value) {
                    setSelectedDate(e.target.value);
                  }
                }}
                title="Filter dashboard by assignments on this IST date"
                className="text-[11px] sm:text-xs font-mono font-medium text-[#ffffff] bg-transparent border-none outline-none cursor-pointer"
              />
            </div>

            {stats && (
              <div className="hidden sm:flex items-center gap-2">
                <div className="flex items-center gap-1.5 bg-[#2c2c2e] border border-[#3a3a3c] px-2.5 py-1 rounded-md text-xs font-mono font-medium text-[#8e8e93]">
                  <span>Candidates:</span>
                  <span className="text-[#ffffff] font-semibold">{stats.totalCandidates}</span>
                </div>

                <div className="flex items-center gap-1.5 bg-[#2c2c2e] border border-[#3a3a3c] px-2.5 py-1 rounded-md text-xs font-mono font-medium text-[#8e8e93]">
                  <span>Jobs:</span>
                  <span className="text-[#ffffff] font-semibold">{stats.totalApplications}</span>
                </div>
              </div>
            )}
          </div>

          {/* Right in Tier 2: Refresh & DevSwitcher */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              title="Refresh Data"
              className="text-xs bg-[#1c1c1e] hover:bg-[#2c2c2e] text-[#8e8e93] hover:text-[#ffffff] border border-[#2c2c2e] px-2.5 py-1 rounded-md active:translate-x-[1px] active:translate-y-[1px] font-semibold transition-all disabled:opacity-60"
            >
              <span className={isRefreshing ? 'inline-block animate-spin' : 'inline-block'}>↻</span>
            </button>

            <DevSwitcher current="/" />
          </div>
        </div>
      </div>
    </header>
  );
};
