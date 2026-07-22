import { describe, expect, it } from 'vitest';
import { parseProxyLines } from './proxies';

describe('parseProxyLines', () => {
  it('parses Geonix host:port:username:password lines', () => {
    const [proxy] = parseProxyLines('us-res.geonix.com:10000:myuser:mypass');
    expect(proxy.server).toBe('http://us-res.geonix.com:10000');
    expect(proxy.username).toBe('myuser');
    expect(proxy.password).toBe('mypass');
  });

  it('parses standard http proxy URLs', () => {
    const [proxy] = parseProxyLines('http://myuser:mypass@proxy.example.com:8080');
    expect(proxy.server).toBe('http://proxy.example.com:8080');
    expect(proxy.username).toBe('myuser');
    expect(proxy.password).toBe('mypass');
  });
});
