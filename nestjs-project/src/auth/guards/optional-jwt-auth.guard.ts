import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';

/**
 * Combine with `@Public()` on the handler: `@Public()` opts the route out of
 * the mandatory global `JwtAuthGuard`, and this guard best-effort attaches
 * `request.user` when a valid Bearer token IS present — without ever
 * rejecting the request when it's absent or invalid. Endpoints that behave
 * differently for anonymous vs. authenticated callers (e.g. owner-only
 * fields) read `request.user` when present and treat it as anonymous
 * otherwise.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    const authHeader = request.headers?.authorization;

    if (authHeader?.startsWith(BEARER_PREFIX)) {
      const token = authHeader.slice(BEARER_PREFIX.length);
      try {
        request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
      } catch {
        // Invalid/expired token on an optional-auth route: proceed as anonymous.
      }
    }

    return true;
  }
}
