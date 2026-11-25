import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import { FolderMoveBlockedError, NetworkError } from '../../types';
import { NO_CACHE_HEADERS } from '../noCacheHeaders';
import { ancestorsOf } from '../RemoteDirCache';
import { isSafeVaultRelativePath } from '../remotePath';
import { NC_NS, readHref, readIsCollection, readMultistatus, readOwncloudProps, readProp, readRemovalProtection } from './propfind';

const PROPERTIES = `<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop><d:resourcetype/><oc:fileid/><oc:permissions/><d:lockdiscovery/><nc:is-mount-root/><nc:mount-type/>
    <nc:is-protected/><nc:is-deletable/><nc:is-renameable/><nc:is-moveable/></d:prop>
</d:propfind>`;
const LOCK = '<d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockinfo>';
const XML = { 'Content-Type': 'application/xml; charset=utf-8' };

interface MoveRequests {
  send(path: string, method: NonNullable<RequestUrlParam['method']>, headers: Record<string, string>, body?: string): Promise<RequestUrlResponse>;
  relativePath(href: string): string | null;
  url(path: string): string;
}

function directoryId(prop: Element): string | null {
  return readIsCollection(prop) ? readOwncloudProps(prop).fileId : null;
}

function lockTokens(prop: Element): string[] {
  const discovery = prop.getElementsByTagNameNS('DAV:', 'lockdiscovery')[0];
  return Array.from(discovery?.getElementsByTagNameNS('DAV:', 'locktoken') ?? [],
    entry => entry.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent?.trim() ?? '');
}

export class FolderMoveDav {
  constructor(private readonly requests: MoveRequests) {}

  async stat(path: string): Promise<{ directoryId: string | null } | null> {
    const prop = await this.statProp(path);
    return prop ? { directoryId: directoryId(prop) } : null;
  }

  private async statProp(path: string): Promise<Element | null> {
    const res = await this.propfind(path, '0');
    if (res.status === 404) return null;
    const responses = this.responses(res, path);
    const prop = responses.length === 1 && this.requests.relativePath(readHref(responses[0])) === path && readProp(responses[0]);
    if (!prop) throw new FolderMoveBlockedError('conflict');
    return prop;
  }

  async move(source: string, destination: string, fileId: string, canSend: () => Promise<boolean>,
    isExcluded: (path: string) => boolean): Promise<void> {
    if ([source, destination].some(path => !isSafeVaultRelativePath(path) || path.split('/').some(part => !part || part === '.'))
      || source === destination || destination.startsWith(`${source}/`) || source.startsWith(`${destination}/`)) {
      throw new FolderMoveBlockedError('scope');
    }
    await this.inspectSource(source, destination, fileId, isExcluded);
    const sourceParents = ancestorsOf(source);
    const targetParents = ancestorsOf(destination);
    const separateParents = [
      ...sourceParents.filter(path => !targetParents.includes(path)),
      ...targetParents.filter(path => !sourceParents.includes(path)),
    ];
    for (const path of separateParents) {
      const parent = await this.statProp(path);
      if (!parent || !readIsCollection(parent)) throw new FolderMoveBlockedError('retry');
      if (parent.getElementsByTagNameNS(NC_NS, 'is-mount-root')[0]?.textContent !== 'false') {
        throw new FolderMoveBlockedError('protected');
      }
    }
    if (!await canSend()) throw new FolderMoveBlockedError('retry');
    const locked = await this.requests.send(source, 'LOCK', { ...XML, Depth: '0', Timeout: 'Second-60', 'If-Match': '*' }, LOCK);
    if ([405, 501].includes(locked.status)) throw new FolderMoveBlockedError('unsupported');
    if (locked.status !== 200) throw new NetworkError(locked.status, locked.text, 'LOCK');
    const token = Object.entries(locked.headers).find(([name]) => name.toLowerCase() === 'lock-token')?.[1];
    if (!token || !/^<opaquelocktoken:[a-z0-9-]+>$/i.test(token)) throw new FolderMoveBlockedError('unsupported');

    let sent = false;
    let moved = false;
    try {
      await this.inspectSource(source, destination, fileId, isExcluded, token.slice(1, -1));
      if (!(await canSend())) throw new FolderMoveBlockedError('retry');
      sent = true;
      const result = await this.requests.send(source, 'MOVE', {
        Destination: this.requests.url(destination), Overwrite: 'F', If: `(${token})`,
      });
      if (result.status !== 201 && result.status !== 204) throw new NetworkError(result.status, result.text, 'MOVE');
      moved = true;
    } finally {
      const paths = moved ? [destination, source] : sent ? [source, destination] : [source];
      for (const path of paths) {
        const result = await this.requests.send(path, 'UNLOCK', { 'Lock-Token': token }).catch(() => null);
        if (result?.status === 204) break;
      }
    }
  }

  private async inspectSource(source: string, destination: string, fileId: string,
    isExcluded: (path: string) => boolean, ownToken?: string): Promise<void> {
    const res = await this.propfind(source, 'infinity');
    let rootConfirmed = false;
    for (const entry of this.responses(res, source)) {
      const path = this.requests.relativePath(readHref(entry));
      const prop = readProp(entry);
      if (path === null || !prop || (path !== source && !path.startsWith(`${source}/`))) {
        throw new FolderMoveBlockedError('conflict');
      }
      if (isExcluded(path) || isExcluded(destination + path.slice(source.length))) throw new FolderMoveBlockedError('scope');
      if (readRemovalProtection(prop)
        || prop.getElementsByTagNameNS(NC_NS, 'is-mount-root')[0]?.textContent !== 'false') {
        throw new FolderMoveBlockedError('protected');
      }
      const tokens = lockTokens(prop);
      if (tokens.some(token => token !== ownToken)) throw new FolderMoveBlockedError('locked');
      if (path === source) {
        if (directoryId(prop) !== fileId) throw new FolderMoveBlockedError('conflict');
        rootConfirmed = !ownToken || tokens.includes(ownToken);
      }
    }
    if (!rootConfirmed) throw new FolderMoveBlockedError(ownToken ? 'unsupported' : 'conflict');
  }

  private propfind(path: string, depth: '0' | 'infinity'): Promise<RequestUrlResponse> {
    return this.requests.send(path, 'PROPFIND', { ...XML, Depth: depth, ...NO_CACHE_HEADERS }, PROPERTIES);
  }

  private responses(res: RequestUrlResponse, path: string): Element[] {
    if (res.status !== 207) throw new NetworkError(res.status, res.text, 'PROPFIND');
    return readMultistatus(res.text, { op: 'folderMove', path, status: res.status, method: 'PROPFIND' });
  }
}
