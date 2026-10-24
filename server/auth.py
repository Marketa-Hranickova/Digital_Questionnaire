"""Staff PIN check with lockout, and one-time iPad session tokens.

Flow:
1. Staff enters PIN + patient code on the iPad -> POST /api/sessions -> one-time token.
2. The patient UI submits answers with that token -> the token is consumed.
3. Staff review / PDF export needs the PIN again (X-Staff-Pin header).

State is in memory: a server restart invalidates all open sessions, which is acceptable for
the pilot (one iPad, short sessions).
"""
import hmac
import secrets
import threading
import time
from dataclasses import dataclass


class AuthError(Exception):
    pass


class LockedOut(AuthError):
    pass


@dataclass
class Session:
    pid: str
    options: dict
    expires_at: float


class PinGuard:
    """Constant-time PIN comparison; locks out after repeated failures."""

    def __init__(self, pin, max_attempts, lockout_seconds, clock=time.monotonic):
        self._pin = pin.encode()
        self._max = max_attempts
        self._lockout = lockout_seconds
        self._clock = clock
        self._failures = 0
        self._locked_until = 0.0
        self._lock = threading.Lock()

    def check(self, candidate):
        with self._lock:
            now = self._clock()
            if now < self._locked_until:
                raise LockedOut("too many wrong PINs, try again later")
            if candidate and hmac.compare_digest(candidate.encode(), self._pin):
                self._failures = 0
                return
            self._failures += 1
            if self._failures >= self._max:
                self._locked_until = now + self._lockout
                self._failures = 0
            raise AuthError("wrong PIN")


class SessionStore:
    """One-time tokens binding an iPad session to a single patient code."""

    def __init__(self, ttl_seconds, clock=time.monotonic):
        self._ttl = ttl_seconds
        self._clock = clock
        self._sessions = {}
        self._lock = threading.Lock()

    def create(self, pid, options):
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._purge()
            self._sessions[token] = Session(pid, options, self._clock() + self._ttl)
        return token

    def consume(self, token):
        """Return the session and delete it, so a token can submit only once."""
        with self._lock:
            self._purge()
            session = self._sessions.pop(token or "", None)
        if session is None:
            raise AuthError("invalid or expired session")
        return session

    def peek(self, token):
        with self._lock:
            self._purge()
            session = self._sessions.get(token or "")
        if session is None:
            raise AuthError("invalid or expired session")
        return session

    def _purge(self):
        now = self._clock()
        for t in [t for t, s in self._sessions.items() if s.expires_at <= now]:
            del self._sessions[t]
