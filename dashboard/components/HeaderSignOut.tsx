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
        <div className="flex items-center gap-2 bg-[#1c1c1e] border border-[#2c2c2e] px-2.5 py-1 rounded-md">
          <div className="w-5 h-5 rounded-full bg-[#2c2c2e] border border-[#3a3a3c] flex items-center justify-center text-[10px] font-bold text-[#ffffff] uppercase">
            {email.charAt(0)}
          </div>
          <span className="text-xs font-medium text-[#8e8e93] max-w-[160px] truncate hidden sm:inline" title={email}>
            {email}
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={handleSignOut}
        title="Sign Out"
        className="text-xs bg-[#1c1c1e] hover:bg-[#2c2c2e] hover:text-[#ffffff] text-[#8e8e93] border border-[#2c2c2e] px-2.5 py-1 rounded-md font-medium transition-all"
      >
        Sign Out
      </button>
    </div>
  );
};

export default HeaderSignOut;
