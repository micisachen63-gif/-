/** Backend says the session is gone (status 401 / Session Unauthorized / redirected to /login). */
export class AuthError extends Error {
  constructor(message) { super(message); this.name = 'AuthError'; }
}

/** Another Chrome (not ours) is holding the project profile. */
export class ProfileBusyError extends Error {
  constructor(message) { super(message); this.name = 'ProfileBusyError'; }
}
