(function (root) {
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  var REFRESH_SKEW_MS = 2 * 60 * 1000;
  var AUTH_SKIP = /\/api\/auth\/(login|refresh|send-signup-otp|verify-signup-otp|register|verify-email)(?:\?|$)/;
  var refreshInFlight = null;
  var nativeFetch = root.fetch.bind(root);
  var ROLE_BY_EMAIL = {
    'yaswanthnaiduyalla@applywizz.ai': 'dev',
    'ramakrishna@applywizz.ai': 'admin',
    'anushabandreddy@applywizz.ai': 'admin',
    'balaji@applywizz.ai': 'manager',
    'ramakrishnaa.tejavath@applywizz.ai': 'manager',
  };

  function homePathForRole(role) {
    if (role === 'dev') return '/dev';
    if (role === 'admin') return '/admin';
    if (role === 'manager') return '/manager';
    return '/';
  }

  function resolveRoleFromEmail(email) {
    var normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return '';
    return ROLE_BY_EMAIL[normalized] || 'operator';
  }

  function sessionUser() {
    try {
      return JSON.parse(localStorage.getItem('applywizz_auth_user') || 'null');
    } catch (e) {
      return null;
    }
  }

  function sessionUserEmail() {
    var user = sessionUser();
    return user && user.email ? user.email : '';
  }

  function persistRole(role) {
    var normalized = String(role || 'operator').trim().toLowerCase();
    if (normalized !== 'dev' && normalized !== 'admin' && normalized !== 'manager' && normalized !== 'operator') {
      normalized = 'operator';
    }
    localStorage.setItem('applywizz_role', normalized);
    if (normalized === 'admin' || normalized === 'dev') {
      localStorage.setItem('applywizz_is_admin', 'true');
    } else {
      localStorage.removeItem('applywizz_is_admin');
    }
    return normalized;
  }

  function sessionRole() {
    var fromEmail = resolveRoleFromEmail(sessionUserEmail());
    if (fromEmail) {
      persistRole(fromEmail);
      return fromEmail;
    }
    var stored = (localStorage.getItem('applywizz_role') || '').trim().toLowerCase();
    if (stored === 'dev' || stored === 'admin' || stored === 'manager' || stored === 'operator') return stored;
    var user = sessionUser();
    var role = user && user.role ? String(user.role).trim().toLowerCase() : '';
    if (role === 'dev' || role === 'admin' || role === 'manager' || role === 'operator') return persistRole(role);
    return 'operator';
  }

  function clearSession() {
    localStorage.removeItem('applywizz_auth_token');
    localStorage.removeItem('applywizz_refresh_token');
    localStorage.removeItem('applywizz_session_expires_at');
    localStorage.removeItem('applywizz_auth_user');
    localStorage.removeItem('applywizz_wh_unreachable');
    localStorage.removeItem('applywizz_is_admin');
    localStorage.removeItem('applywizz_role');
  }

  function persistSession(data, renewExpiry) {
    if (!data) return sessionRole();
    if (data.token) localStorage.setItem('applywizz_auth_token', data.token);
    var refresh = data.refreshToken || data.refresh_token;
    if (refresh) localStorage.setItem('applywizz_refresh_token', refresh);
    if (data.user) localStorage.setItem('applywizz_auth_user', JSON.stringify(data.user));
    if (renewExpiry) {
      var ttlMs = Number(data.sessionTtlSeconds) > 0 ? Number(data.sessionTtlSeconds) * 1000 : WEEK_MS;
      localStorage.setItem('applywizz_session_expires_at', String(Date.now() + ttlMs));
    }
    var email = (data.user && data.user.email) || data.email || sessionUserEmail();
    if (data.role) {
      var serverRole = persistRole(data.role);
      if (data.user) {
        try {
          var merged = Object.assign({}, data.user, { role: serverRole, email: String(email || data.user.email || '').trim().toLowerCase() });
          localStorage.setItem('applywizz_auth_user', JSON.stringify(merged));
        } catch (e) { /* ignore */ }
      }
      return serverRole;
    }
    var fromEmail = resolveRoleFromEmail(email);
    if (fromEmail) return persistRole(fromEmail);
    return sessionRole();
  }

  function signOut() {
    var token = localStorage.getItem('applywizz_auth_token');
    if (token) {
      nativeFetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
      }).catch(function () {});
    }
    clearSession();
    window.location.replace('/');
  }

  function sessionCapExpired() {
    var raw = localStorage.getItem('applywizz_session_expires_at');
    if (!raw) return false;
    var expires = Number(raw);
    return Number.isFinite(expires) && Date.now() > expires;
  }

  function tokenExpiryMs(token) {
    if (!token) return 0;
    try {
      var parts = token.split('.');
      if (parts.length < 2) return 0;
      var base = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (base.length % 4) base += '=';
      var payload = JSON.parse(atob(base));
      return payload.exp ? payload.exp * 1000 : 0;
    } catch (e) {
      return 0;
    }
  }

  function needsRefresh() {
    if (sessionCapExpired()) return false;
    var refresh = localStorage.getItem('applywizz_refresh_token');
    if (!refresh) return false;
    var exp = tokenExpiryMs(localStorage.getItem('applywizz_auth_token'));
    if (!exp) return true;
    return Date.now() >= exp - REFRESH_SKEW_MS;
  }

  function refreshSession() {
    if (refreshInFlight) return refreshInFlight;
    if (sessionCapExpired()) {
      clearSession();
      return Promise.resolve(false);
    }
    var refreshToken = localStorage.getItem('applywizz_refresh_token');
    if (!refreshToken) return Promise.resolve(false);

    refreshInFlight = nativeFetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refreshToken }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok || !data.token) {
            clearSession();
            return false;
          }
          persistSession(data, false);
          return true;
        });
      })
      .catch(function () {
        return false;
      })
      .then(function (ok) {
        refreshInFlight = null;
        return ok;
      });

    return refreshInFlight;
  }

  function ensureSession() {
    if (sessionCapExpired()) {
      clearSession();
      return Promise.resolve(false);
    }
    if (!needsRefresh()) return Promise.resolve(true);
    return refreshSession();
  }

  function redirectToRoleHome(role) {
    var home = homePathForRole(role);
    if (window.location.pathname !== home) {
      window.location.replace(home);
      return true;
    }
    return false;
  }

  function enforcePageAccess(allowedRoles) {
    var token = localStorage.getItem('applywizz_auth_token');
    var refresh = localStorage.getItem('applywizz_refresh_token');
    var role = sessionRole();
    if (!token && !refresh) return { ok: false, reason: 'anon', role: null };
    if (sessionCapExpired()) {
      clearSession();
      return { ok: false, reason: 'anon', role: null };
    }
    if (role === 'dev' || allowedRoles.indexOf(role) !== -1) return { ok: true, role: role };
    redirectToRoleHome(role);
    return { ok: false, reason: 'redirect', role: role };
  }

  function getAuthHeaders() {
    var token = localStorage.getItem('applywizz_auth_token');
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  function headerValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    return headers[name] || headers[name.toLowerCase()] || '';
  }

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function shouldManageAuth(url) {
    if (url.indexOf('/api/') === -1 && url.indexOf(location.origin + '/api/') !== 0) return false;
    return !AUTH_SKIP.test(url);
  }

  root.fetch = function (input, init) {
    var url = requestUrl(input);
    if (!shouldManageAuth(url)) return nativeFetch(input, init);

    var previousToken = localStorage.getItem('applywizz_auth_token');
    var incomingAuth = headerValue(init && init.headers, 'Authorization');

    return ensureSession().then(function () {
      var headers = Object.assign({}, init && init.headers && typeof init.headers.forEach !== 'function' ? init.headers : {});
      if (init && init.headers && typeof init.headers.forEach === 'function') {
        init.headers.forEach(function (value, key) {
          headers[key] = value;
        });
      }
      if (!incomingAuth || (previousToken && incomingAuth === 'Bearer ' + previousToken)) {
        Object.assign(headers, getAuthHeaders());
      }
      var opts = Object.assign({}, init || {}, { headers: headers });
      return nativeFetch(input, opts).then(function (res) {
        if (res.status !== 401 || !localStorage.getItem('applywizz_refresh_token')) return res;
        return refreshSession().then(function (ok) {
          if (!ok) return res;
          Object.assign(headers, getAuthHeaders());
          return nativeFetch(input, Object.assign({}, init || {}, { headers: headers }));
        });
      });
    });
  };

  function getTodayIST() {
    var ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return ist.getUTCFullYear() + '-' + String(ist.getUTCMonth() + 1).padStart(2, '0') + '-' + String(ist.getUTCDate()).padStart(2, '0');
  }

  ensureSession();
  setInterval(function () {
    ensureSession();
  }, 10 * 60 * 1000);

  root.ApplyWizzRoles = {
    homePathForRole: homePathForRole,
    sessionRole: sessionRole,
    sessionUserEmail: sessionUserEmail,
    persistRole: persistRole,
    persistSession: persistSession,
    clearSession: clearSession,
    signOut: signOut,
    ensureSession: ensureSession,
    redirectToRoleHome: redirectToRoleHome,
    enforcePageAccess: enforcePageAccess,
    getAuthHeaders: getAuthHeaders,
    getTodayIST: getTodayIST,
  };
})(window);
