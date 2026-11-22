import { DOMParser } from '@xmldom/xmldom';
import { confirmsEmptyCollection, readRemovalProtection } from '../../../src/network/dav/propfind';

const element = (xml: string): Element => new DOMParser().parseFromString(xml, 'text/xml').documentElement as unknown as Element;

const prop = (permissions: string, properties = ''): Element => element(
  `<d:prop xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
    <oc:permissions>${permissions}</oc:permissions>${properties}</d:prop>`,
);

describe('DAV folder protection', () => {
  it('distinguishes a Team Folder mount from an ordinary folder inside it', () => {
    const group = '<nc:mount-type>group</nc:mount-type>';
    expect(readRemovalProtection(prop('MGDNVCK', `${group}<nc:is-mount-root>true</nc:is-mount-root>`))).toBe(true);
    expect(readRemovalProtection(prop('MGDNVCK', `${group}<nc:is-mount-root>false</nc:is-mount-root>`))).toBe(false);
  });

  it('honours Folder Protection and the absence of effective DELETE rights', () => {
    expect(readRemovalProtection(prop('RGDNVCK', '<nc:is-protected>true</nc:is-protected>'))).toBe(true);
    expect(readRemovalProtection(prop('RGDNVCK', '<nc:is-deletable>false</nc:is-deletable>'))).toBe(true);
    expect(readRemovalProtection(prop('RGCK'))).toBe(true);
    expect(readRemovalProtection(prop('RGDNVCK'))).toBe(false);
  });

  it('requires the exact collection response to prove emptiness', () => {
    const folder = (href: string): Element => element(`<d:response xmlns:d="DAV:"><d:href>${href}</d:href>
      <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`);
    const target = (href: string): boolean => href === '/Vault/target/';
    const root = folder('/Vault/target/');
    expect(confirmsEmptyCollection([root], target)).toBe(true);
    expect(confirmsEmptyCollection([], target)).toBe(false);
    expect(confirmsEmptyCollection([folder('/Vault/other/')], target)).toBe(false);
    expect(confirmsEmptyCollection([root, folder('/Vault/target/child/')], target)).toBe(false);
  });
});
