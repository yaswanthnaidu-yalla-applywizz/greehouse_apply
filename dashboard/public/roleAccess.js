(function (root) {
  var SESSION_TTL_MS = 6 * 60 * 60 * 1000;
  var REFRESH_SKEW_MS = 2 * 60 * 1000;
  var AUTH_SKIP = /\/api\/auth\/(login|refresh|send-signup-otp|verify-signup-otp|register|verify-email)(?:\?|$)/;
  var MANAGER_VIEW_AS_OPERATOR_KEY = 'applywizz_manager_view_as_operator';
  var VIEW_AS_MANAGER_EMAIL_KEY = 'applywizz_view_as_manager_email';
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
    // TODO: migrate to HttpOnly cookies (ARCH phase)
    sessionStorage.removeItem('applywizz_auth_token');
    sessionStorage.removeItem('applywizz_refresh_token');
    localStorage.removeItem('applywizz_auth_token');
    localStorage.removeItem('applywizz_refresh_token');
    localStorage.removeItem('applywizz_session_expires_at');
    localStorage.removeItem('applywizz_auth_user');
    localStorage.removeItem('applywizz_wh_unreachable');
    localStorage.removeItem('applywizz_is_admin');
    localStorage.removeItem('applywizz_role');
    try {
      sessionStorage.removeItem(MANAGER_VIEW_AS_OPERATOR_KEY);
      sessionStorage.removeItem(VIEW_AS_MANAGER_EMAIL_KEY);
    } catch (e) { /* ignore */ }
  }

  function persistSession(data, renewExpiry) {
    if (!data) return sessionRole();
    // TODO: migrate to HttpOnly cookies (ARCH phase)
    if (data.token) {
      sessionStorage.setItem('applywizz_auth_token', data.token);
      localStorage.setItem('applywizz_auth_token', data.token);
    }
    var refresh = data.refreshToken || data.refresh_token;
    if (refresh) {
      sessionStorage.setItem('applywizz_refresh_token', refresh);
      localStorage.setItem('applywizz_refresh_token', refresh);
    }
    if (data.user) localStorage.setItem('applywizz_auth_user', JSON.stringify(data.user));
    if (renewExpiry) {
      var ttlMs = Number(data.sessionTtlSeconds) > 0 ? Number(data.sessionTtlSeconds) * 1000 : SESSION_TTL_MS;
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
    // TODO: migrate to HttpOnly cookies (ARCH phase)
    var token = sessionStorage.getItem('applywizz_auth_token') || localStorage.getItem('applywizz_auth_token');
    if (token) {
      nativeFetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
      }).catch(function () {});
    }
    clearSession();
    window.location.replace('/');
  }

  function redirectToLogin() {
    clearSession();
    if (window.location.pathname !== '/') {
      window.location.replace('/');
    }
  }

  function sessionCapExpired() {
    var expiresAt = Number(localStorage.getItem('applywizz_session_expires_at') || 0);
    return expiresAt > 0 && Date.now() >= expiresAt;
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
    var refresh = sessionStorage.getItem('applywizz_refresh_token') || localStorage.getItem('applywizz_refresh_token');
    if (!refresh) return false;
    var exp = tokenExpiryMs(sessionStorage.getItem('applywizz_auth_token') || localStorage.getItem('applywizz_auth_token'));
    if (!exp) return true;
    return Date.now() >= exp - REFRESH_SKEW_MS;
  }

  function refreshSession() {
    if (refreshInFlight) return refreshInFlight;
    if (sessionCapExpired()) {
      clearSession();
      return Promise.resolve(false);
    }
    var refreshToken = sessionStorage.getItem('applywizz_refresh_token') || localStorage.getItem('applywizz_refresh_token');
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
      redirectToLogin();
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
    var token = sessionStorage.getItem('applywizz_auth_token') || localStorage.getItem('applywizz_auth_token');
    var refresh = sessionStorage.getItem('applywizz_refresh_token') || localStorage.getItem('applywizz_refresh_token');
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

  function isOpsMode() {
    try {
      var role = sessionRole();
      if (role !== 'manager' && role !== 'dev') return false;
      return sessionStorage.getItem(MANAGER_VIEW_AS_OPERATOR_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function getOpsModeManagerEmail() {
    try {
      return String(sessionStorage.getItem(VIEW_AS_MANAGER_EMAIL_KEY) || '').trim().toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function setOpsMode(opts) {
    opts = opts || {};
    try {
      if (opts.enabled) {
        var role = sessionRole();
        if (role !== 'manager' && role !== 'dev') return;
        var mgr = String(opts.managerEmail || '').trim().toLowerCase();
        if (!mgr) return;
        sessionStorage.setItem(MANAGER_VIEW_AS_OPERATOR_KEY, '1');
        sessionStorage.setItem(VIEW_AS_MANAGER_EMAIL_KEY, mgr);
      } else {
        sessionStorage.removeItem(MANAGER_VIEW_AS_OPERATOR_KEY);
        sessionStorage.removeItem(VIEW_AS_MANAGER_EMAIL_KEY);
      }
    } catch (e) { /* ignore */ }
  }

  function isManagerOperatorView() {
    return isOpsMode() && sessionRole() === 'manager';
  }

  function setManagerOperatorView(enabled) {
    if (enabled) {
      setOpsMode({ enabled: true, managerEmail: sessionUserEmail() });
    } else {
      setOpsMode({ enabled: false });
    }
  }

  function getAuthHeaders() {
    var token = sessionStorage.getItem('applywizz_auth_token') || localStorage.getItem('applywizz_auth_token');
    if (!token) return {};
    var headers = { Authorization: 'Bearer ' + token };
    if (isOpsMode()) {
      headers['X-View-As'] = 'operator';
      if (sessionRole() === 'dev') {
        var mgrEmail = getOpsModeManagerEmail();
        if (mgrEmail) headers['X-View-As-Manager-Email'] = mgrEmail;
      }
    }
    return headers;
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

    var previousToken = sessionStorage.getItem('applywizz_auth_token') || localStorage.getItem('applywizz_auth_token');
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
        if (res.status !== 401 || (!sessionStorage.getItem('applywizz_refresh_token') && !localStorage.getItem('applywizz_refresh_token'))) return res;
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

  function initPageLoadRefresh() {
    var storedRefresh = sessionStorage.getItem('applywizz_refresh_token') || localStorage.getItem('applywizz_refresh_token');
    if (!storedRefresh) return Promise.resolve(true);

    refreshSession().then(function (ok) {
      if (!ok) {
        redirectToLogin();
      }
      return ok;
    });
    return Promise.resolve(true);
  }

  initPageLoadRefresh();

  var REFRESH_INTERVAL_MS = 30 * 60 * 1000;
  setInterval(function () {
    refreshSession().then(function (ok) {
      if (!ok) {
        redirectToLogin();
      }
    });
  }, REFRESH_INTERVAL_MS);

  function getAccessToken() {
    return sessionStorage.getItem('applywizz_auth_token') || localStorage.getItem('applywizz_auth_token') || '';
  }

  root.getAccessToken = getAccessToken;
  root.ApplyWizzRoles = {
    getAccessToken: getAccessToken,
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
    isOpsMode: isOpsMode,
    setOpsMode: setOpsMode,
    getOpsModeManagerEmail: getOpsModeManagerEmail,
    isManagerOperatorView: isManagerOperatorView,
    setManagerOperatorView: setManagerOperatorView,
  };
})(window);
