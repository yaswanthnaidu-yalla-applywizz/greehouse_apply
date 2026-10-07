import React from 'react';
import { sessionRole } from '../hooks/useSession.js';

interface DevSwitcherProps {
  current: string;
}

export const DevSwitcher: React.FC<DevSwitcherProps> = ({ current }) => {
  if (sessionRole() !== 'dev') return null;
  const links = [
    { href: '/dev', label: 'Dev' },
    { href: '/admin', label: 'Admin' },
    { href: '/manager', label: 'Manager' },
    { href: '/', label: 'Operator' },
  ];
  return (
    <nav className="flex flex-wrap items-center gap-1 bg-[#1c1c1e] border border-[#2c2c2e] rounded-lg p-1">
      {links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          onClick={() => {
            if (link.href === '/') {
              sessionStorage.setItem('applywizz_dev_operator_view', 'true');
            } else {
              sessionStorage.removeItem('applywizz_dev_operator_view');
            }
          }}
          className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
            current === link.href
              ? 'bg-[#2c2c2e] text-[#ffffff] border border-[#3a3a3c]'
              : 'text-[#8e8e93] hover:text-[#ffffff] hover:bg-[#2c2c2e]/60'
          }`}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
};

export default DevSwitcher;
