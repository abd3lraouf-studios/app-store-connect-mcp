import { describe, it, expect } from 'vitest';
import { shapeResponse, approximateChars } from '../src/shape.js';

describe('shapeResponse', () => {
  it('drops links.self but keeps links.next so pagination survives', () => {
    const shaped = shapeResponse({
      data: [{ id: '1', type: 'apps', links: { self: 'https://x/1' } }],
      links: { self: 'https://x', next: 'https://x?cursor=2' },
    }) as any;
    expect(shaped.links).toEqual({ next: 'https://x?cursor=2' });
    expect(shaped.data[0].links).toBeUndefined();
  });

  it('drops relationships that carry only links', () => {
    const shaped = shapeResponse({
      data: { id: '1', relationships: { builds: { links: { self: 'a', related: 'b' } } } },
    }) as any;
    expect(shaped.data.relationships).toBeUndefined();
  });

  it('keeps relationships that actually carry data', () => {
    const shaped = shapeResponse({
      data: {
        id: '1',
        relationships: {
          builds: { links: { self: 'a' }, data: [{ id: 'b1', type: 'builds' }] },
          empty: { links: { self: 'c' } },
        },
      },
    }) as any;
    expect(shaped.data.relationships.builds.data).toHaveLength(1);
    expect(shaped.data.relationships.builds.links).toBeUndefined();
    expect(shaped.data.relationships.empty).toBeUndefined();
  });

  it('treats an explicitly null relationship as carrying nothing', () => {
    const shaped = shapeResponse({ data: { relationships: { parent: { data: null } } } }) as any;
    expect(shaped.data.relationships).toBeUndefined();
  });

  it('leaves attributes untouched', () => {
    const attrs = { name: 'App', bundleId: 'com.x', nested: { a: [1, 2] } };
    const shaped = shapeResponse({ data: { attributes: attrs } }) as any;
    expect(shaped.data.attributes).toEqual(attrs);
  });

  it('returns the payload unchanged when disabled', () => {
    const raw = { data: { links: { self: 'x' } } };
    expect(shapeResponse(raw, false)).toEqual(raw);
  });

  it('measurably shrinks a realistic listing', () => {
    const payload = {
      data: Array.from({ length: 50 }, (_, i) => ({
        id: String(i),
        type: 'subscriptionPricePoints',
        attributes: { customerPrice: '4.99', proceeds: '3.49' },
        links: { self: `https://api.appstoreconnect.apple.com/v1/subscriptionPricePoints/${i}` },
        relationships: {
          subscription: {
            links: {
              self: `https://api.appstoreconnect.apple.com/v1/subscriptionPricePoints/${i}/relationships/subscription`,
              related: `https://api.appstoreconnect.apple.com/v1/subscriptionPricePoints/${i}/subscription`,
            },
          },
          territory: {
            links: {
              self: `https://api.appstoreconnect.apple.com/v1/subscriptionPricePoints/${i}/relationships/territory`,
              related: `https://api.appstoreconnect.apple.com/v1/subscriptionPricePoints/${i}/territory`,
            },
          },
        },
      })),
    };
    const before = approximateChars(payload);
    const after = approximateChars(shapeResponse(payload));
    expect(after).toBeLessThan(before * 0.4);
  });
});
