/**
 * Localhost detection utilities
 * DRY refactor: consolidates 11 duplicate localhost checks
 * Localhost-boundary validation
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * Check if an IP address is localhost
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 addresses
 */
export function isLocalhost(ip: string | undefined): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * Middleware that requires localhost access
 * Returns 403 for non-localhost requests
 */
export function requireLocalhost(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress;

  if (!isLocalhost(ip)) {
    res.status(403).json({ error: 'Localhost only' });
    return;
  }

  next();
}
