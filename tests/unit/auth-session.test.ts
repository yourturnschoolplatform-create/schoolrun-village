import { describe, expect, it } from 'vitest';
import { hasAuthCallbackParams } from '../../src/lib/auth-session';

function fakeLocation(search: string, hash = ''): Location {
  return {
    search,
    hash,
    pathname: '/',
    href: `http://localhost/${search}${hash}`,
  } as Location;
}

describe('auth callback detection', () => {
  it('detects PKCE code and email token_hash', () => {
    expect(hasAuthCallbackParams(fakeLocation('?code=abc'))).toBe(true);
    expect(hasAuthCallbackParams(fakeLocation('?token_hash=xyz&type=signup'))).toBe(true);
  });

  it('detects implicit hash tokens', () => {
    expect(hasAuthCallbackParams(fakeLocation('', '#access_token=tok&type=signup'))).toBe(true);
  });

  it('ignores plain school invite links', () => {
    expect(hasAuthCallbackParams(fakeLocation('?invite=school-token'))).toBe(false);
  });
});
