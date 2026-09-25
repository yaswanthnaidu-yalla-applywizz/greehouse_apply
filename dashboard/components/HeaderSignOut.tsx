import React from 'react';
import { sessionUserEmail, signOut } from '../hooks/useSession.js';

interface HeaderSignOutProps {
  onSignOut?: () => void | Promise<void>;
}

export const HeaderSignOut: React.FC<HeaderSignOutProps> = ({ onSignOut }) => {
  const email = sessionUserEmail();

  const handleSignOut = () => {
    if (onSignOut) {
      void onSignOut();
    } else {
      void signOut();
    }
  };

  return (
    <div className="flex items-center gap-2">
      {email && (
        <div className="flex items-center gap-2 bg-white border border-[#1A1A2E] px-2.5 py-1 rounded">
          <div className="w-5 h-5 rounded-full bg-[#E88474] border border-[#1A1A2E] flex items-center justify-center text-[10px] font-black text-white uppercase">
            {email.charAt(0)}
          </div>
          <span className="text-xs font-bold text-[#1A1A2E] max-w-[160px] truncate hidden sm:inline" title={email}>
            {email}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={handleSignOut}
        title="Sign Out"
        className="text-xs bg-[#FFF5EB] hover:bg-[#E88474] hover:text-white text-[#1A1A2E] border border-[#1A1A2E] px-2.5 py-1 rounded active:translate-x-[1px] active:translate-y-[1px] font-bold transition-all"
      >
        Sign Out
      </button>
    </div>
  );
};

export default HeaderSignOut;
