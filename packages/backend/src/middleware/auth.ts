import { Request, Response, NextFunction } from 'express';
import { parse as parseCookie } from 'cookie';
import crypto from 'crypto';
import {
  createWebSession,
  getWebSession,
  deleteExpiredSessions,
} from '../services/db.js';
import { getBytelightConfig } from '../config.js';

const COOKIE_NAME = 'bytelight_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function getCookieName(): string {
  return COOKIE_NAME;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const config = getBytelightConfig();
  if (!config.auth.password) {
    next();
    return;
  }

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const cookies = parseCookie(cookieHeader);
  const sessionToken = cookies[COOKIE_NAME];

  if (!sessionToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const session = getWebSession(sessionToken);
  if (!session) {
    res.status(401).json({ error: 'Invalid session' });
    return;
  }

  if (new Date(session.expires_at) < new Date()) {
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  next();
}

export function loginHandler(req: Request, res: Response): void {
  const config = getBytelightConfig();
  if (!config.auth.password) {
    res.status(500).json({ error: 'Authentication not configured' });
    return;
  }

  const { password } = req.body;
  if (!password) {
    res.status(400).json({ error: 'Password required' });
    return;
  }

  const inputBuffer = Buffer.from(password);
  const expectedBuffer = Buffer.from(config.auth.password);

  const maxLen = Math.max(inputBuffer.length, expectedBuffer.length);
  const paddedInput = Buffer.alloc(maxLen);
  const paddedExpected = Buffer.alloc(maxLen);
  inputBuffer.copy(paddedInput);
  expectedBuffer.copy(paddedExpected);

  const isValid = crypto.timingSafeEqual(paddedInput, paddedExpected) &&
                  inputBuffer.length === expectedBuffer.length;

  if (!isValid) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  deleteExpiredSessions();

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

  createWebSession({
    id: crypto.randomUUID(),
    token: sessionToken,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  const isSecure = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  res.cookie(COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: isSecure,
    sameSite: isSecure ? 'strict' : 'lax',
    maxAge: SESSION_DURATION_MS,
    path: '/',
  });

  res.json({ success: true });
}

export function logoutHandler(req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  });
  res.json({ success: true });
}

export function sessionCheckHandler(req: Request, res: Response): void {
  const config = getBytelightConfig();
  const authRequired = !!config.auth.password;
  if (!authRequired) {
    res.json({ authenticated: true, auth_required: false });
    return;
  }

  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    res.json({ authenticated: false });
    return;
  }

  const cookies = parseCookie(cookieHeader);
  const sessionToken = cookies[COOKIE_NAME];

  if (!sessionToken) {
    res.json({ authenticated: false });
    return;
  }

  const session = getWebSession(sessionToken);
  if (!session || new Date(session.expires_at) < new Date()) {
    res.json({ authenticated: false });
    return;
  }

  res.json({ authenticated: true });
}
