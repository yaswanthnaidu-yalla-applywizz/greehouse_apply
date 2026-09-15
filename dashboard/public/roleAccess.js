(function (root) {
  function homePathForRole(role) {
    if (role === 'dev') return '/dev';
    if (role === 'admin') return '/admin';
    if (role === 'manager') return '/manager';
    return '/';
  }

  function sessionRole() {
    const stored = (localStorage.getItem('applywizz_role') || '').trim().toLowerCase();
    if (stored === 'dev' || stored === 'admin' || stored === 'manager' || stored === 'operator') return stored;
    try {
      const user = JSON.parse(localStorage.getItem('applywizz_auth_user') || 'null');
      const role = user && user.role ? String(user.role).trim().toLowerCase() : '';
      if (role === 'dev' || role === 'admin' || role === 'manager' || role === 'operator') return role;
    } catch (e) {}
    if (localStorage.getItem('applywizz_is_admin') === 'true') return 'admin';
    return 'operator';
  }

  function persistRole(role) {
    const normalized = String(role || 'operator').trim().toLowerCase();
    localStorage.setItem('applywizz_role', normalized);
    if (normalized === 'admin' || normalized === 'dev') {
      localStorage.setItem('applywizz_is_admin', 'true');
    } else {
      localStorage.removeItem('applywizz_is_admin');
    }
    return normalized;
  }

  function redirectToRoleHome(role) {
    const home = homePathForRole(role);
    if (window.location.pathname !== home) {
      window.location.replace(home);
      return true;
    }
    return false;
  }

  function enforcePageAccess(allowedRoles) {
    const token = localStorage.getItem('applywizz_auth_token');
    const role = sessionRole();
    if (!token) return { ok: false, reason: 'anon', role: null };
    if (role === 'dev' || allowedRoles.indexOf(role) !== -1) return { ok: true, role: role };
    redirectToRoleHome(role);
    return { ok: false, reason: 'redirect', role: role };
  }

  function getAuthHeaders() {
    const token = localStorage.getItem('applywizz_auth_token');
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  function getTodayIST() {
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return ist.getUTCFullYear() + '-' + String(ist.getUTCMonth() + 1).padStart(2, '0') + '-' + String(ist.getUTCDate()).padStart(2, '0');
  }

  root.ApplyWizzRoles = {
    homePathForRole: homePathForRole,
    sessionRole: sessionRole,
    persistRole: persistRole,
    redirectToRoleHome: redirectToRoleHome,
    enforcePageAccess: enforcePageAccess,
    getAuthHeaders: getAuthHeaders,
    getTodayIST: getTodayIST,
  };
})(window);
