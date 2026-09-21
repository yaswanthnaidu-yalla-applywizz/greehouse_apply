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
    <nav className="flex flex-wrap items-center gap-1 bg-white border-2 border-[#1A1A2E] rounded p-1">
      {links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          onClick={link.href === '/' ? () => sessionStorage.setItem('applywizz_dev_operator_view', 'true') : undefined}
          className={`px-2 py-1 text-xs font-bold rounded ${current === link.href ? 'bg-[#E88474] text-white' : 'hover:bg-[#FAF4EB]'}`}
        >
          {link.label}
        </a>
      ))}
    </nav>
  );
};

export default DevSwitcher;
